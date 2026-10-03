/**
 * Politica unică de cache HTTP pentru rutele GET din `app/api/**`
 * (edge Cloudflare + browser). Documentație + regula Cloudflare:
 * docs/infra/edge-cache.md.
 *
 * Trei clase:
 *  - public   — răspunsul depinde DOAR de URL (cale + query). Cloudflare îl
 *               cache-uiește `s-maxage`, apoi îl servește stale cât se
 *               revalidează (`stale-while-revalidate`).
 *  - anonymous — la fel, dar numai pentru vizitatori fără cookie de identitate;
 *               cu sesiune → `private, no-store`. Regula Cloudflare ocolește
 *               cache-ul când cererea are un cookie de identitate (Cloudflare
 *               ignoră `Vary: Cookie`), deci varianta anonimă nu ajunge
 *               niciodată la un utilizator logat.
 *  - per-user / realtime — implicit: middleware-ul pune `private, no-store`
 *               pe orice GET /api/* din afara PUBLIC_ROUTES / NEXT_MANAGED_ROUTES
 *               (antetul din middleware câștigă în fața handler-ului).
 *
 * Reguli pentru rutele publice: fără Set-Cookie, fără ieșire dependentă de
 * cookie/antete (limba și moneda vin din query), cache doar pe 200.
 *
 * Modul pur (fără importuri Node) — folosit și din middleware (Edge).
 */

export const NO_STORE = "private, no-store";

export type CacheProfile = {
    /** Secunde la edge (Cloudflare). */
    sMaxAge: number;
    /** Secunde în care edge-ul poate servi copia veche cât revalidează. */
    staleWhileRevalidate: number;
    /** Secunde în browser (mic: altfel o invalidare nu ajunge la client). */
    maxAge: number;
};

/** TTL-uri pe tip de conținut — singurul loc unde se schimbă. */
export const CACHE_PROFILES = {
    /** Taxonomii, liste de orașe, jocuri — se schimbă rar. */
    static: { sMaxAge: 3600, staleWhileRevalidate: 86_400, maxAge: 300 },
    /** Cataloage externe preîncălzite la 15 min (radio, Jamendo). */
    external: { sMaxAge: 900, staleWhileRevalidate: 3600, maxAge: 60 },
    /** Cataloage din DB (shop, muzică, filme, produse). */
    catalog: { sMaxAge: 300, staleWhileRevalidate: 1800, maxAge: 30 },
    /** Articole, subtitrări, pagini de detaliu. */
    detail: { sMaxAge: 600, staleWhileRevalidate: 3600, maxAge: 60 },
    /** Liste care se mișcă (știri, misiuni, feed anonim). */
    list: { sMaxAge: 60, staleWhileRevalidate: 600, maxAge: 15 },
    /** Căutări și autocomplete. */
    search: { sMaxAge: 120, staleWhileRevalidate: 600, maxAge: 30 },
    /** Aproape-live (liste de stream-uri, sloturi). */
    live: { sMaxAge: 15, staleWhileRevalidate: 60, maxAge: 0 },
    /** Proxy geocodare (Nominatim) — rezultate stabile, politica lor cere cache. */
    geo: { sMaxAge: 86_400, staleWhileRevalidate: 604_800, maxAge: 3600 },
} as const satisfies Record<string, CacheProfile>;

export type CacheProfileName = keyof typeof CACHE_PROFILES;
export type CacheAudience = "public" | "anonymous";
export type PublicRouteRule = { profile: CacheProfileName; audience: CacheAudience };

/**
 * Rutele GET cache-uibile la edge (cheia = calea sub `app/api`, ca în sistemul
 * de fișiere). Testul `tests/unit/cache-policy-routes.test.ts` verifică că
 * fiecare există, folosește helper-ul de aici și nu setează cookie-uri.
 */
export const PUBLIC_ROUTES = {
    "audio/feed": { profile: "external", audience: "public" },
    "audio/search": { profile: "search", audience: "public" },
    "audio/tracks": { profile: "catalog", audience: "public" },
    categories: { profile: "static", audience: "public" },
    // Anonim: pentru un viewer logat feed-ul exclude creatorii blocați (per utilizator).
    "feed/universal": { profile: "list", audience: "anonymous" },
    "founding-slots": { profile: "list", audience: "public" },
    "gaming/games": { profile: "static", audience: "public" },
    "geo/search": { profile: "geo", audience: "public" },
    "geo/reverse": { profile: "geo", audience: "public" },
    "live/streams": { profile: "live", audience: "public" },
    missions: { profile: "list", audience: "public" },
    news: { profile: "list", audience: "public" },
    posts: { profile: "list", audience: "public" },
    "posts/[slug]": { profile: "list", audience: "public" },
    /** Doar cu `?locale=&currency=` în URL (altfel no-store) — vezi hasUrlPreferences. */
    products: { profile: "catalog", audience: "public" },
    "products/[id]": { profile: "detail", audience: "public" },
    "products/[id]/videos": { profile: "catalog", audience: "public" },
    "products/similar": { profile: "catalog", audience: "public" },
    "search/suggest": { profile: "search", audience: "public" },
    "shop/products": { profile: "catalog", audience: "public" },
    "stays/cities": { profile: "static", audience: "public" },
    "stays/search": { profile: "search", audience: "anonymous" },
    "trips/packages": { profile: "catalog", audience: "public" },
    "fly/deals": { profile: "catalog", audience: "public" },
    "videos/[id]/captions": { profile: "detail", audience: "public" },
    "videos/[id]/captions/list": { profile: "detail", audience: "public" },
    "videos/[id]/products": { profile: "catalog", audience: "public" },
    "music/home": { profile: "catalog", audience: "anonymous" },
    "movies/home": { profile: "catalog", audience: "anonymous" },
    "v1/feed": { profile: "list", audience: "anonymous" },
} as const satisfies Record<string, PublicRouteRule>;

export type PublicRoute = keyof typeof PUBLIC_ROUTES;

/**
 * Rute GET al căror Cache-Control îl pune Next (ISR: `export const revalidate`),
 * nu handler-ul — middleware-ul nu are voie să-l suprascrie.
 */
export const NEXT_MANAGED_ROUTES = ["fx"] as const;

/** Cheile sunt căi din sistemul de fișiere (`[a-z0-9-]` + segmente dinamice `[id]`). */
function routePattern(route: string): RegExp {
    const body = route
        .split("/")
        .map((seg) => (/^\[[a-zA-Z]+\]$/.test(seg) ? "[^/]+" : seg.replace(/[^a-z0-9-]/g, "")))
        .join("/");
    return new RegExp(`^/api/${body}/?$`);
}

const SELF_MANAGED_PATTERNS: RegExp[] = [...Object.keys(PUBLIC_ROUTES), ...NEXT_MANAGED_ROUTES].map(routePattern);

/**
 * Calea `/api/...` își stabilește singură politica de cache (listă publică sau
 * ISR). Pentru toate celelalte, middleware-ul pune `private, no-store` —
 * antetele din middleware BAT antetele handler-ului (verificat pe `next start`),
 * deci nu le putem pune peste tot.
 */
export function managesOwnCacheHeaders(pathname: string): boolean {
    return SELF_MANAGED_PATTERNS.some((re) => re.test(pathname));
}

/**
 * Cookie-uri care identifică vizitatorul (sesiuni + id-uri anonime folosite la
 * personalizare). Oglindite în expresia regulii Cloudflare din
 * docs/infra/edge-cache.md — țineți-le sincronizate (testul verifică).
 */
export const IDENTITY_COOKIES = [
    "swypik_session",
    "creator_session",
    "seller_session",
    "admin_session",
    "admin_token",
    "anon_session",
    "swypik_anon",
    "feed_sid",
] as const;

/**
 * Limba și moneda sunt date explicit în URL. Rutele care, altfel, le-ar citi
 * din cookie (`swypik_locale`, `swypik_currency`) sunt publice doar atunci.
 */
export function hasUrlPreferences(url: URL): boolean {
    return Boolean(url.searchParams.get("locale") && url.searchParams.get("currency"));
}

export function cacheControlValue(profile: CacheProfileName): string {
    const p: CacheProfile = CACHE_PROFILES[profile];
    return `public, max-age=${p.maxAge}, s-maxage=${p.sMaxAge}, stale-while-revalidate=${p.staleWhileRevalidate}`;
}

/** Cererea nu poartă niciun cookie de identitate. */
export function isAnonymousRequest(req: Request): boolean {
    const header = req.headers.get("cookie");
    if (!header) return true;
    const names = new Set(
        header.split(";").map((part) => part.split("=")[0]?.trim()).filter(Boolean),
    );
    return !IDENTITY_COOKIES.some((name) => names.has(name));
}

/**
 * Aplică politica rutei pe un răspuns deja construit. Publică doar un 200 fără
 * Set-Cookie (pentru audiența `anonymous`, doar fără cookie de identitate);
 * altfel `private, no-store` — o eroare sau un 429 nu ajung niciodată în cache.
 */
export function applyCachePolicy<T extends Response>(res: T, route: PublicRoute, req: Request): T {
    const rule: PublicRouteRule = PUBLIC_ROUTES[route];
    const cacheable =
        res.status === 200 &&
        !res.headers.has("set-cookie") &&
        (rule.audience === "public" || isAnonymousRequest(req));
    res.headers.set("Cache-Control", cacheable ? cacheControlValue(rule.profile) : NO_STORE);
    // Un singur antet de adevăr: CDN-Cache-Control vechi ar suprascrie s-maxage la Cloudflare.
    res.headers.delete("CDN-Cache-Control");
    // `Vary: Cookie` e ignorat de Cloudflare (izolarea o face regula de cache) și
    // ar fragmenta inutil cache-ul browserului.
    if (cacheable) res.headers.delete("Vary");
    return res;
}

/** Marchează explicit un răspuns ca per-utilizator. */
export function applyNoStore<T extends Response>(res: T): T {
    res.headers.set("Cache-Control", NO_STORE);
    res.headers.delete("CDN-Cache-Control");
    return res;
}
