import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/lib/i18n/routing";
import { LOCALES, LOCALE_COOKIE } from "@/lib/i18n/config";
import { NON_LOCALIZED_PREFIXES } from "@/lib/i18n/non-localized";
import { APP_URL } from "@/lib/app-url";
import { applicationRequestOrigins } from "@/lib/url-origins";
import { mediaCspOrigins } from "@/lib/storage/config";
import { NO_STORE, managesOwnCacheHeaders } from "@/lib/http/cache-policy";
import { isWellFormedAdminToken, verifyAdminSession } from "@/lib/admin/edge-session";

const SHOPPER_COOKIE = "swypik_session";
const LEGACY_CREATOR_COOKIE = "creator_session";
const SELLER_COOKIE = "seller_session";
const ADMIN_COOKIE = "admin_token";
const ADMIN_SESSION_COOKIE = "admin_session";
const LOCALE_COOKIE_NAME = LOCALE_COOKIE;

// Rute care NU primesc niciodată prefix de limbă (API, back-office, auth,
// sitemap-uri, .well-known) — lista e în lib/i18n/non-localized.ts.
function isNonLocalized(pathname: string): boolean {
  return NON_LOCALIZED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const LOCALE_PREFIX_RE = new RegExp(`^/(?:${LOCALES.join("|")})(?=/|$)`);
function stripLocale(pathname: string): string {
  const stripped = pathname.replace(LOCALE_PREFIX_RE, "");
  return stripped === "" ? "/" : stripped;
}
function currentLocalePrefix(pathname: string): string {
  const m = pathname.match(LOCALE_PREFIX_RE);
  return m ? m[0] : "";
}

// ---------- Host canonic: www → apex, http → https ----------
//
// Cloudflare servește și `www.` și `http://` fără redirect (audit 2026-09-28).
// Regula de edge („Always Use HTTPS” + redirect www) e o acțiune a owner-ului;
// până atunci (și ca plasă de siguranță) aplicația redirecționează singură.
// Verificările locale (curl 127.0.0.1, healthcheck) nu au host-ul public și
// nici X-Forwarded-Proto, deci nu sunt atinse.
function forwardedProto(req: NextRequest): string | null {
  const xf = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (xf) return xf;
  try {
    const scheme = JSON.parse(req.headers.get("cf-visitor") || "{}")?.scheme;
    return typeof scheme === "string" ? scheme.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function canonicalHostRedirect(req: NextRequest, appUrl: string = APP_URL): NextResponse | null {
  let app: URL;
  try {
    app = new URL(appUrl);
  } catch {
    return null;
  }
  if (app.hostname === "localhost" || app.hostname === "127.0.0.1") return null;
  const host = (req.headers.get("host") || "").split(",")[0].trim().toLowerCase();
  const isWww = host === `www.${app.host}`;
  const isHttp = app.protocol === "https:" && host === app.host && forwardedProto(req) === "http";
  if (!isWww && !isHttp) return null;
  const target = new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, app.origin);
  // 308 păstrează metoda (un POST rămâne POST) — echivalentul permanent al 307.
  return NextResponse.redirect(target, 308);
}

// ---------- CSRF / Origin guard ----------

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_EXEMPT_PREFIXES = [
  "/api/webhooks/",
  "/api/cron/",
  "/api/health",
];

function allowedOrigins(req: NextRequest): string[] {
  return applicationRequestOrigins({
    appUrl: APP_URL,
    requestOrigin: `${req.nextUrl.protocol}//${req.nextUrl.host}`,
    extraOrigins: process.env.ALLOWED_ORIGINS_EXTRA,
    development: process.env.NODE_ENV === "development",
  });
}

function hostFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function csrfBlocked(req: NextRequest): boolean {
  if (!MUTATING_METHODS.has(req.method)) return false;
  const { pathname } = req.nextUrl;

  const hasAuthCookie =
    Boolean(req.cookies.get(SHOPPER_COOKIE)?.value) ||
    Boolean(req.cookies.get(SELLER_COOKIE)?.value) ||
    Boolean(req.cookies.get(ADMIN_COOKIE)?.value) ||
    Boolean(req.cookies.get(ADMIN_SESSION_COOKIE)?.value) ||
    Boolean(req.cookies.get(LEGACY_CREATOR_COOKIE)?.value);
  if (!hasAuthCookie) return false;

  if (CSRF_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) return false;

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const candidate = origin || hostFromUrl(referer);
  if (!candidate) return true;

  const allowed = allowedOrigins(req);
  return !allowed.includes(candidate.replace(/\/$/, ""));
}

function redirectTo(req: NextRequest, target: string, withRedirect = true) {
  const url = new URL(target, req.url);
  if (withRedirect) {
    url.searchParams.set("redirect", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  }
  return NextResponse.redirect(url);
}

const intlMiddleware = createIntlMiddleware(routing);

// Verifică dacă pathname-ul canonical (fără prefix locale) declanșează un redirect
// din regulile gated. Returnează ținta de redirect sau `null` dacă request-ul e OK.
function gatedRedirectTarget(
  pathname: string,
  hasShopper: boolean,
  hasLegacyCreator: boolean,
  hasSeller: boolean,
  hasAdmin: boolean,
  localePrefix: string,
): string | null {
  const localized = (path: string) =>
    `${localePrefix}${path.startsWith("/") ? path : `/${path}`}`;

  if (pathname.startsWith("/admin/") && pathname !== "/admin/") {
    if (!hasAdmin) return "/admin";
  }
  if (
    pathname.startsWith("/seller/") &&
    pathname !== "/seller/" &&
    pathname !== "/seller/login" &&
    !pathname.startsWith("/seller/login/")
  ) {
    if (!hasSeller) return "/seller/login";
  }
  const gatedPrefixes = ["/collections", "/orders", "/checkout", "/creator"];
  const isGated = gatedPrefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  const isAuthed = hasShopper || hasLegacyCreator;
  if (isGated && !isAuthed) {
    return localized("/account");
  }
  return null;
}

function adminLoginRedirect(req: NextRequest): NextResponse {
  const res = NextResponse.redirect(new URL("/admin", req.url));
  // Token inventat/revocat: îl ștergem, altfel fiecare navigare îl re-verifică.
  res.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "strict" });
  return res;
}

/**
 * Paginile /admin/* (inclusiv cererile RSC parțiale, pentru care Next sare peste
 * layout): cookie cu formă greșită → login, fără I/O; cookie bine format →
 * validat server-side (lib/admin/edge-session.ts). Rutele API /api/admin/*
 * se păzesc singure (requireAdmin).
 */
async function adminPageGate(req: NextRequest, pathname: string): Promise<NextResponse | null> {
  if (!pathname.startsWith("/admin/")) return null;
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!isWellFormedAdminToken(token)) return adminLoginRedirect(req);
  return (await verifyAdminSession(token)) === "invalid" ? adminLoginRedirect(req) : null;
}

/**
 * next-intl pune `swypik_locale` pe ORICE răspuns al unui vizitator fără cookie
 * al cărui Accept-Language diferă de limba paginii — deci pe aproape toate
 * cererile anonime pe `/` (boți, CDN), iar Set-Cookie face răspunsul
 * necacheabil la edge. Cu `localeDetection: false`, pe o rută FĂRĂ prefix
 * limba e oricum cea implicită: cookie-ul nu schimbă nimic → nu-l trimitem.
 * Pe rutele cu prefix (`/en/...`) alegerea e explicită și rămâne salvată.
 */
export function dropRedundantLocaleCookie(req: NextRequest, res: NextResponse): NextResponse {
  if (req.cookies.has(LOCALE_COOKIE_NAME) || currentLocalePrefix(req.nextUrl.pathname)) return res;
  const all = res.headers.getSetCookie();
  const keep = all.filter((c) => !c.startsWith(`${LOCALE_COOKIE_NAME}=`));
  if (keep.length === all.length) return res;
  res.headers.delete("set-cookie");
  for (const c of keep) res.headers.append("set-cookie", c);
  return res;
}

export async function middleware(request: NextRequest) {
  // 0) Host canonic (www → apex, http → https).
  const canonicalRedirect = canonicalHostRedirect(request);
  if (canonicalRedirect) return canonicalRedirect;

  // 1) CSRF check.
  if (csrfBlocked(request)) {
    return new NextResponse(JSON.stringify({ error: "csrf" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const { pathname } = request.nextUrl;

  // 1b) Anti-scanner: boți trimit POST cu header `Next-Action` malformat (ex. "x")
  //     pe pagini publice → Next.js aruncă "Server Reference ID did not match"
  //     și umple logurile. Un ID valid de server action e hex de 40 caractere.
  //     Respingem devreme cu 400, fără să atingem runtime-ul de server actions.
  if (request.method === "POST") {
    const nextAction = request.headers.get("next-action");
    if (nextAction && !/^[0-9a-f]{40}$/i.test(nextAction)) {
      return new NextResponse(null, { status: 400 });
    }
  }

  // 2) Rute non-localizate: aplicăm DOAR auth gating, fără next-intl.
  if (isNonLocalized(pathname)) {
    const cookies = request.cookies;
    const hasShopper = Boolean(cookies.get(SHOPPER_COOKIE)?.value);
    const hasLegacyCreator = Boolean(cookies.get(LEGACY_CREATOR_COOKIE)?.value);
    const hasSeller = Boolean(cookies.get(SELLER_COOKIE)?.value);
    const hasAdmin = isWellFormedAdminToken(cookies.get(ADMIN_COOKIE)?.value);

    if (pathname.startsWith("/api/")) return apiResponseDefaults(request);
    // Un cookie de admin prezent dar invalid e respins (și șters) înainte de
    // regula generică „fără cookie → /admin”.
    if (cookies.get(ADMIN_COOKIE)?.value) {
      const adminRedirect = await adminPageGate(request, pathname);
      if (adminRedirect) return adminRedirect;
    }
    const target = gatedRedirectTarget(
      pathname,
      hasShopper,
      hasLegacyCreator,
      hasSeller,
      hasAdmin,
      "",
    );
    if (target) return redirectTo(request, target, target === "/account");
    return applyStrictCsp(request, pathname);
  }

  // 3) Verificăm gating ÎNAINTE de next-intl (pentru rute localizate),
  //    folosind forma canonică (fără prefix).
  const cookies = request.cookies;
  const hasShopper = Boolean(cookies.get(SHOPPER_COOKIE)?.value);
  const hasLegacyCreator = Boolean(cookies.get(LEGACY_CREATOR_COOKIE)?.value);
  const hasSeller = Boolean(cookies.get(SELLER_COOKIE)?.value);
  const hasAdmin = isWellFormedAdminToken(cookies.get(ADMIN_COOKIE)?.value);

  const prefix = currentLocalePrefix(pathname);
  const canonical = stripLocale(pathname);

  const gatedTarget = gatedRedirectTarget(
    canonical,
    hasShopper,
    hasLegacyCreator,
    hasSeller,
    hasAdmin,
    prefix,
  );
  if (gatedTarget) {
    return redirectTo(request, gatedTarget, gatedTarget.endsWith("/account"));
  }

  // 4) Delegăm restul (locale resolution, rewrite, cookie set) către next-intl.
  return dropRedundantLocaleCookie(request, await intlMiddleware(request));
}

// ---------- Cache implicit pentru API ----------
//
// Orice GET /api/* e per-utilizator până la proba contrarie: `private, no-store`.
// Excepție: rutele din lib/http/cache-policy.ts (PUBLIC_ROUTES + ISR) își pun
// singure Cache-Control. Atenție: antetele setate aici CÂȘTIGĂ în fața celor din
// handler (verificat pe `next start`), de aceea excepția e explicită, nu „handler-ul
// îl suprascrie”. Regula Cloudflare cache-uiește doar răspunsurile cu `s-maxage`
// (docs/infra/edge-cache.md).
// Proxy-ul HLS cu token (lib/media/stream-proxy.ts) își pune singur antetele:
// playlist `private, no-store`, segmente `private, max-age=…` (cache doar în browser).
const MEDIA_STREAM_RE = /^\/api\/(?:movies|music)\/stream\//;

function apiResponseDefaults(request: NextRequest): NextResponse {
  const res = NextResponse.next();
  const { method } = request;
  const path = request.nextUrl.pathname;
  if ((method === "GET" || method === "HEAD") && !managesOwnCacheHeaders(path) && !MEDIA_STREAM_RE.test(path)) {
    res.headers.set("Cache-Control", NO_STORE);
  }
  return res;
}

// ---------- CSP nonce-based (rute sensibile) ----------
//
// 2026-08-11 (audit): nonce per-request + 'strict-dynamic' pe dashboard-urile
// sensibile NON-localizate (admin, seller, creator, courier), unde controlăm
// noi NextResponse.next() și putem forwarda header-ele de request din care
// Next.js extrage nonce-ul pentru scripturile lui inline. Rutele localizate
// (checkout/account) trec prin next-intl (răspuns construit de el) — acolo
// rămâne CSP-ul global din next.config.mjs; extindere ulterioară daco vrem.
// Pe rutele cu nonce, XSS-ul injectat NU mai poate executa scripturi inline
// arbitrare — doar scripturile cu nonce-ul curent (+ lanțul lor, strict-dynamic).
const STRICT_CSP_PREFIXES = ["/admin", "/seller", "/creator", "/courier"];

function wantsStrictCsp(canonicalPath: string): boolean {
  return STRICT_CSP_PREFIXES.some(
    (p) => canonicalPath === p || canonicalPath.startsWith(`${p}/`),
  );
}

function buildStrictCsp(nonce: string): string {
  // Originile de media din env (CDN R2, URL-uri semnate, endpoint de upload direct).
  const media = mediaCspOrigins().map((origin) => ` ${origin}`).join("");
  return [
    "default-src 'self'",
    // strict-dynamic: scripturile cu nonce pot încărca alte scripturi (Next chunks);
    // https: + unsafe-inline sunt fallback IGNORATE de browserele moderne când
    // există nonce — rămân doar pentru browsere vechi fără strict-dynamic.
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `media-src 'self' blob: https://media.swypik.com https://cdn.swypik.com${media}`,
    // `https://*.ingest.sentry.io`: fără el, browserul blochează raportarea
    // erorilor chiar cu DSN valid, iar eșecul e tăcut. A se ține sincronizat cu
    // cele două CSP-uri din `next.config.mjs` (SENTRY_CONNECT_SRC).
    `connect-src 'self' https://swypik.com https://www.swypik.com https://api.swypik.com https://media.swypik.com https://cdn.swypik.com${media} https://api.stripe.com https://*.stripe.com https://*.ingest.sentry.io`,
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function applyStrictCsp(request: NextRequest, canonicalPath: string): NextResponse {
  // HEAD primește aceleași antete ca GET (scanere/monitorizare citesc HEAD).
  if ((request.method !== "GET" && request.method !== "HEAD") || !wantsStrictCsp(canonicalPath)) {
    return NextResponse.next();
  }
  // Nonce criptografic per request (Edge runtime: Web Crypto).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = buildStrictCsp(nonce);
  // Next.js extrage nonce-ul din header-ul CSP al REQUEST-ului forwarded și
  // îl aplică automat scripturilor lui inline la randarea dinamică.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

// Extensiile fișierelor statice reale (public/ + asset-uri). NU „orice punct”:
// `/u/zz.qq` (username cu punct) trebuie să treacă prin middleware (i18n), iar
// /api/** trece MEREU (CSRF + no-store), chiar și `/api/…/index.m3u8`.
// Sincron cu regex-ul din `config.matcher` (verificat în test).
export const STATIC_FILE_EXTENSIONS = [
  "ico", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp",
  "css", "js", "mjs", "map", "json", "webmanifest", "txt", "xml",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "webm", "mp3", "m4a", "wav", "ogg", "pdf", "wasm", "html",
] as const;

export const config = {
  matcher: [
    // Exclude fișierele statice (favicon.svg, icoane PWA, manifest, imagini,
    // video) — altfel middleware-ul i18n le prefixează cu locale și Next.js
    // returnează 404 pentru ele. Next cere aici un literal static.
    "/((?!_next/static|_next/image|(?!api/).*\\.(?:ico|png|jpg|jpeg|gif|webp|avif|svg|bmp|css|js|mjs|map|json|webmanifest|txt|xml|woff|woff2|ttf|otf|eot|mp4|webm|mp3|m4a|wav|ogg|pdf|wasm|html)$).*)",
  ],
};
