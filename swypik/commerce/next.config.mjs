import createNextIntlPlugin from "next-intl/plugin";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

const isDev = process.env.NODE_ENV === "development";
// Sentry trimite evenimentele prin XHR către `https://<org>.ingest.sentry.io`.
// Fără intrarea asta în `connect-src`, browserul le blochează chiar dacă DSN-ul
// e corect — iar eșecul e tăcut: Sentry pare configurat, dar nu ajunge nimic.
// Ținut într-o constantă fiindcă CSP-ul e definit în TREI locuri (aici de două
// ori + `middleware.ts`); a fost deja o sursă de divergență.
const SENTRY_CONNECT_SRC = "https://*.ingest.sentry.io";
// Cloudflare Realtime: RealtimeKit (apeluri Messenger) vorbește din browser cu
// API-ul/socket-ul lui pe *.realtime.cloudflare.com. Live (SFU) NU are nevoie de
// intrări aici: semnalizarea trece prin /api/live/* (same-origin), iar media
// WebRTC/TURN (UDP/TCP, turn.cloudflare.com) nu e guvernată de connect-src.
// Suprascriere/extindere: CSP_REALTIME_CONNECT_SRC (listă separată prin spații).
const REALTIME_CONNECT_SRC =
  process.env.CSP_REALTIME_CONNECT_SRC ||
  "https://*.realtime.cloudflare.com wss://*.realtime.cloudflare.com";
// Explicit allowlist — do NOT widen back to `https:` (open connect-src let any
// page/script exfiltrate to arbitrary hosts). New modules (Movies, Music, News,
// Gaming, Messenger) call third-party APIs (Audius,
// Jamendo, Radio-Browser, CheapShark, OpenTDB, Azure AI) ONLY from
// server code (lib/**), never from the browser — see app/api/* proxies — so
// none of those hosts need to be here.
// Media (R2 + CDN, docs/infra/r2.md): originile vin din env — CDN-ul public,
// originea URL-urilor semnate și endpointul S3 pe care browserul urcă direct.
// Oglinda lui `mediaCspOrigins()` din lib/storage/config.ts (folosit de middleware).
function httpsOrigin(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}
const MEDIA_CSP_ORIGINS = Array.from(new Set([
  process.env.MEDIA_PUBLIC_BASE_URL || process.env.S3_PUBLIC_URL || process.env.S3_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL,
  process.env.MEDIA_SIGNED_BASE_URL,
  process.env.S3_PRESIGN_ENDPOINT || process.env.S3_UPLOAD_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
].map(httpsOrigin).filter(Boolean)));
const MEDIA_CONNECT_SRC = MEDIA_CSP_ORIGINS.length ? ` ${MEDIA_CSP_ORIGINS.join(" ")}` : "";
const MEDIA_IMAGE_PATTERNS = MEDIA_CSP_ORIGINS.map((origin) => ({ protocol: "https", hostname: new URL(origin).hostname }));
const CONNECT_SRC = `'self' https://swypik.com https://www.swypik.com https://api.swypik.com https://media.swypik.com https://cdn.swypik.com${MEDIA_CONNECT_SRC} https://api.stripe.com https://*.stripe.com ${SENTRY_CONNECT_SRC} ${REALTIME_CONNECT_SRC}`;
// media-src stays broad (`https:`) on purpose: Swypik Music plays internet
// radio streams (lib/audio/radio-browser.ts) whose stream URLs come from
// arbitrary stations' own hosts picked at request time — there is no fixed
// allowlist possible. img-src also stays `https:` for the same class of
// arbitrary-host cover art / thumbnails.
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://js.stripe.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  media-src 'self' blob: data: https:;
    connect-src ${CONNECT_SRC};
  worker-src 'self' blob:;
  frame-src https://js.stripe.com https://hooks.stripe.com;
  font-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  form-action 'self' https://checkout.stripe.com;
  frame-ancestors 'none';
  upgrade-insecure-requests;
`.replace(/\s{2,}/g, " ").trim();
const cspReportOnly = `
  default-src 'self';
  script-src 'self' https://js.stripe.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  media-src 'self' blob: data: https:;
  connect-src ${CONNECT_SRC};
  worker-src 'self' blob:;
  frame-src https://js.stripe.com https://hooks.stripe.com;
  font-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  form-action 'self' https://checkout.stripe.com;
  frame-ancestors 'none';
`.replace(/\s{2,}/g, " ").trim();


// ─── Replici web identice, fără stare (docs/infra/stateless-checklist.md) ───
// 1) BUILD_ID determinist = commitul: toate replicile construite din același
//    commit servesc aceleași URL-uri /_next/static/<buildId>/…, deci un client
//    încărcat de replica A găsește chunk-urile și pe replica B. Fără BUILD_COMMIT
//    (dev/CI local) Next generează un id aleator, ca înainte.
//    Hash-ul variabilelor coapte în bundle (NEXT_PUBLIC_* / FEATURE_*) intră în
//    id: același commit reconstruit cu alte flag-uri (`deploy.sh --flags`) are
//    alte chunk-uri, deci trebuie alt id (și alt prefix în cache-ul partajat).
const BUILD_COMMIT = (process.env.BUILD_COMMIT || "").trim();
const bakedEnv = Object.keys(process.env)
  .filter((k) => k.startsWith("NEXT_PUBLIC_") || k.startsWith("FEATURE_"))
  .sort()
  .map((k) => `${k}=${process.env[k]}`)
  .join(";");
const DETERMINISTIC_BUILD_ID = /^[0-9a-zA-Z._-]{7,64}$/.test(BUILD_COMMIT) && BUILD_COMMIT !== "unknown"
  ? `${BUILD_COMMIT.slice(0, 40)}-${createHash("sha256").update(bakedEnv).digest("hex").slice(0, 8)}`
  : null;
// Service worker-ul e un fișier static. Dacă URL-ul lui ar rămâne mereu
// /sw.js, un deploy care schimbă doar bundle-urile Next poate să nu instaleze
// un worker nou (scriptul SW e byte-identical). Versionăm URL-ul din client cu
// același id determinist al build-ului.
const SERVICE_WORKER_VERSION = DETERMINISTIC_BUILD_ID || (isDev ? "dev" : "unknown-build");
// 2) Cache-ul Next (ISR, unstable_cache, fetch cache, revalidatePath/Tag)
//    partajat prin Redis; memoria locală a lui Next e oprită (cacheMaxMemorySize 0)
//    ca o replică să nu servească o intrare invalidată de pe altă replică.
//    Fallback grațios pe memorie când Redis lipsește (lib/next-cache/store.cjs).
//    `NEXT_CACHE_HANDLER=off` revine la cache-ul implicit pe disc (o singură replică).
const useSharedCache = !isDev && process.env.NEXT_CACHE_HANDLER !== "off";
const CACHE_HANDLER_PATH = fileURLToPath(new URL("./lib/next-cache/redis-cache-handler.cjs", import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_BUILD_STANDALONE === "1" ? "standalone" : undefined,
  generateBuildId: async () => DETERMINISTIC_BUILD_ID,
  env: {
    NEXT_PUBLIC_SW_VERSION: SERVICE_WORKER_VERSION,
  },
  ...(useSharedCache ? { cacheHandler: CACHE_HANDLER_PATH, cacheMaxMemorySize: 0 } : {}),
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Compresia (brotli/gzip) o face Cloudflare la edge — replicile nu mai ard CPU
  // pe gzip pentru fiecare răspuns (Tunnel → origin e HTTP intern). NEXT_COMPRESS=1
  // o repornește pentru un deploy fără Cloudflare în față. (w6-performance)
  compress: process.env.NEXT_COMPRESS === "1",
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
  },
  images: {
    // Fără optimizatorul din server (/_next/image): bytes-ii imaginilor de pe
    // CDN nu trec prin aplicație. Loader-ul întoarce URL-ul CDN direct sau prin
    // Cloudflare Image Transformations (lib/storage/image-loader.ts).
    loader: "custom",
    loaderFile: "./lib/storage/image-loader.ts",
    // Explicit allowlist — `hostname: '**'` for http AND https was an open
    // image proxy (any URL could be requested through /_next/image). Arbitrary-
    // host images from the new modules (radio station favicons, Audius/Jamendo
    // cover art, podcast artwork, gaming deal thumbnails) are rendered with
    // plain <img> in those components (not next/image), so they don't need an
    // entry here — see components/music/*, app/[locale]/gaming/page.tsx.
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'commons.wikimedia.org' },
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: 'cdn.swypik.com' },
      { protocol: 'https', hostname: 'media.swypik.com' },
      ...MEDIA_IMAGE_PATTERNS,
    ],
  },
  // ─── Cloudflare + Performance Headers ───
  async redirects() {
    return [
      { source: "/login", destination: "/auth/login", permanent: true },
      { source: "/register", destination: "/auth/signup", permanent: true },
      { source: "/signup", destination: "/auth/signup", permanent: true },
      { source: "/categorii", destination: "/categories", permanent: true },
      { source: "/categorii/:slug*", destination: "/categories/:slug*", permanent: true },
      { source: "/reels", destination: "/explore", permanent: true },
      { source: "/sellers", destination: "/seller", permanent: true },
      { source: "/legal", destination: "/legal/terms", permanent: true },
      { source: "/feed", destination: "/explore", permanent: true },
      { source: "/trending", destination: "/explore?sort=trending", permanent: true },
      { source: "/wishlist", destination: "/account/saved", permanent: true },
      { source: "/settings", destination: "/account/settings", permanent: true },
      { source: "/returns", destination: "/account/returns", permanent: true },
      { source: "/auth/register", destination: "/auth/signup", permanent: true },
      { source: "/auth/forgot-password", destination: "/auth/forgot", permanent: true },
      { source: "/sell", destination: "/seller", permanent: true },
      { source: "/contact", destination: "/help", permanent: true },
      { source: "/favorites", destination: "/account/saved", permanent: true },
      { source: "/manifest.webmanifest", destination: "/manifest.json", permanent: true },
    ];
  },
  async headers() {
    if (isDev) return [];
    return [
      {
        // Service worker-ul trebuie revalidat la fiecare update check; cache
        // agresiv aici poate ține un bundle vechi activ după deploy.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Public folder static assets (icons, favicons, images) — 1 year immutable
        // Fără m3u8/ts: playlist-urile HLS vin din /api (semnate, per utilizator,
        // `no-store` din middleware) — un CDN-Cache-Control de 1 an le-ar fi
        // servit altor utilizatori. /public nu conține astfel de fișiere.
        source: '/:path*.:ext(ico|png|jpg|jpeg|webp|avif|gif|svg|woff2|woff|mp4)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'CDN-Cache-Control', value: 'public, max-age=31536000' },
        ],
      },
      {
        // Static assets: cache 1 year (Cloudflare + browser)
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'CDN-Cache-Control', value: 'public, max-age=31536000' },
        ],
      },
      {
        // All pages: security + performance headers
        // 2026-08-11 (audit): CSP-ul global NU se aplică pe dashboard-urile
        // sensibile (admin/seller/creator/courier) — acolo middleware-ul
        // setează CSP nonce-based per request, iar regula de aici l-ar
        // suprascrie (next.config headers se aplică peste cele din middleware).
        source: '/((?!admin|seller|creator|courier).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          { key: 'Content-Security-Policy', value: cspHeader },
          { key: 'Content-Security-Policy-Report-Only', value: cspReportOnly },
        ],
      },
      {
        // Dashboard-urile sensibile: aceleași security headers, DAR fără CSP
        // (vine din middleware, nonce-based).
        source: '/(admin|seller|creator|courier)(/.*)?',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
        ],
      },
      // (w6-performance) Scoase regulile `public, s-maxage` pentru `/` și
      // `/product/:id*`: pagina de produs e `force-dynamic` și citește sesiunea,
      // deci NU are voie în cache partajat; `/` e ISR și primește deja de la Next
      // `s-maxage` = `revalidate`. Politica de edge: docs/infra/edge-cache.md.
    ];
  },
};

// 2026-08-24 (audit perf): SDK-ul Sentry stă în chunk-ul partajat (~26-44% din
// First Load JS) fără să treacă prin plugin-ul lui de build. Am MĂSURAT varianta
// `withSentryConfig(..., { webpack: { treeshake: { removeDebugLogging: true } } })`:
// bundle-ul partajat a crescut 185 kB → 188 kB, pentru că plugin-ul adaugă mai
// mult decât scoate atâta timp cât tracing-ul rămâne activ. Câștigul real
// (~22-49 kB) cere `removeTracing: true`, care dezactivează complet performance
// monitoring-ul — decizie de produs, nu optimizare gratuită. Lăsat neschimbat
// intenționat; vezi RAPORT.md.
export default withNextIntl(nextConfig);
