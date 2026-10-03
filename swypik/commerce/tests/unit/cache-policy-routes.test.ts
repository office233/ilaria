/**
 * Garda clasificării rutelor GET pentru cache-ul de edge (lib/http/cache-policy.ts,
 * docs/infra/edge-cache.md). Pică dacă:
 *  - o rută din lista publică lipsește, nu trece prin helper, setează cookie-uri
 *    sau (audiență `public`) își personalizează ieșirea după sesiune;
 *  - o rută per-utilizator / realtime ajunge în lista publică sau emite s-maxage;
 *  - cineva pune un `Cache-Control: public …` scris de mână în afara modulului unic.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NEXT_MANAGED_ROUTES, PUBLIC_ROUTES, managesOwnCacheHeaders } from "@/lib/http/cache-policy";

const API_DIR = path.resolve(__dirname, "../../app/api");

function routeFile(route: string): string {
  return path.join(API_DIR, ...route.split("/"), "route.ts");
}

function source(route: string): string {
  return fs.readFileSync(routeFile(route), "utf8");
}

/**
 * Doar handler-ul GET (fișierele au și POST-uri autentificate): de la definiția
 * lui `GET`/`GET_impl` până la următorul `export` de nivel superior.
 */
function getHandlerSource(src: string): string {
  const starts = [/async function GET_impl\(/, /export (async )?function GET\(/, /export const GET\s*=/]
    .map((re) => src.search(re))
    .filter((i) => i >= 0);
  if (starts.length === 0) return src;
  const start = Math.min(...starts);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(export |async function (POST|PUT|PATCH|DELETE)_impl)/);
  return end < 0 ? src.slice(start) : src.slice(start, start + 1 + end);
}

function allRouteFiles(dir = API_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return allRouteFiles(full);
    return e.name === "route.ts" ? [full] : [];
  });
}

function routeKey(file: string): string {
  return path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
}

const SETS_COOKIE = /cookies\(\)\s*\)?\.set\(|\.cookies\.set\(|set-cookie|setFeedSessionCookie|cookieStore\.set\(/i;
const READS_IDENTITY = /getAuthUser\(|getAuthSession\(|getOptionalSocialUserId\(|getAccountUserId\(|requireSession\(/;
const HAND_WRITTEN_PUBLIC = /["'`]public,|s-maxage/;

/** Rute publice care citesc cookie-uri DOAR ca fallback și devin publice numai cu preferințele în URL. */
const URL_PREFERENCE_ROUTES = new Set(["products", "products/[id]"]);

/** Per-utilizator: nu au voie în cache partajat (primesc `private, no-store` din middleware sau explicit). */
const PER_USER_ROUTES = [
  "account/export", "auth/me", "auth/orders", "cart", "collections", "collections/[id]",
  "dm/conversations", "explore/feed", "feed/offers", "feed/offers/liked", "gaming/profile", "geo",
  "me/activity", "me/notifications", "me/referral", "missions/active", "movies/[slug]/unlock",
  "music/playlists", "notifications", "orders", "orders/[id]", "stripe-connect/status",
  "users/me", "users/me/addresses", "users/me/stats", "users/me/saved-videos", "users/me/privacy",
  "users/me/onboarding", "users/me/notification-preferences", "stays/mine", "host/listings",
  "merchants/mine", "rides/[id]",
];

/** Realtime / SSE: niciodată în cache. */
const REALTIME_ROUTES = ["dm/stream/[id]", "dispatch/[jobId]/stream", "rides/[id]/stream", "live/streams/[id]/chat"];

describe("rutele publice (edge-cacheable)", () => {
  for (const [route, rule] of Object.entries(PUBLIC_ROUTES)) {
    describe(route, () => {
      it("există și are GET", () => {
        expect(fs.existsSync(routeFile(route)), routeFile(route)).toBe(true);
        expect(source(route)).toMatch(/export (async )?function GET|export const GET/);
      });

      it("trece prin applyCachePolicy cu cheia proprie", () => {
        const src = source(route);
        expect(src).toContain('from "@/lib/http/cache-policy"');
        expect(src).toContain(`"${route}"`);
        expect(src).toMatch(/applyCachePolicy\(/);
      });

      it("nu setează cookie-uri", () => {
        expect(source(route)).not.toMatch(SETS_COOKIE);
      });

      it("nu scrie de mână antete publice", () => {
        expect(source(route)).not.toMatch(HAND_WRITTEN_PUBLIC);
      });

      if (rule.audience === "public" && !URL_PREFERENCE_ROUTES.has(route)) {
        it("audiență publică ⇒ GET-ul nu depinde de sesiune/cookie", () => {
          const src = getHandlerSource(source(route));
          expect(src).not.toMatch(READS_IDENTITY);
          expect(src).not.toMatch(/cookies\(\)|headers\.get\(["']cookie["']\)/);
        });
      }

      if (URL_PREFERENCE_ROUTES.has(route)) {
        it("publică doar cu limba+moneda din URL (hasUrlPreferences), altfel no-store", () => {
          const src = source(route);
          expect(src).toContain("hasUrlPreferences(");
          expect(src).toContain("applyNoStore(");
        });
      }
    });
  }
});

describe("rutele per-utilizator și realtime", () => {
  it.each([...PER_USER_ROUTES, ...REALTIME_ROUTES])("%s nu e publică și nu emite s-maxage", (route) => {
    expect(fs.existsSync(routeFile(route)), routeFile(route)).toBe(true);
    expect(Object.keys(PUBLIC_ROUTES)).not.toContain(route);
    const src = source(route);
    expect(src).not.toMatch(HAND_WRITTEN_PUBLIC);
    expect(src).not.toMatch(/applyCachePolicy\(/);
  });

  it("rutele SSE (text/event-stream) nu sunt în lista publică", () => {
    for (const file of allRouteFiles()) {
      const src = fs.readFileSync(file, "utf8");
      if (/text\/event-stream|sseResponse|createSseResponse/.test(src)) {
        expect(Object.keys(PUBLIC_ROUTES), routeKey(file)).not.toContain(routeKey(file));
      }
    }
  });
});

describe("middleware: cine primește `private, no-store` implicit", () => {
  const selfManaged = new Set<string>([...Object.keys(PUBLIC_ROUTES), ...NEXT_MANAGED_ROUTES]);
  const samplePath = (key: string) => `/api/${key.replace(/\[[^\]]+\]/g, "x1")}`;

  it("rutele publice și ISR sunt lăsate să-și pună singure antetul", () => {
    for (const key of selfManaged) expect(managesOwnCacheHeaders(samplePath(key)), key).toBe(true);
  });

  it("nicio altă rută (inclusiv frații statici ai rutelor dinamice publice) nu scapă de default", () => {
    const leaks = allRouteFiles()
      .map(routeKey)
      .filter((key) => !selfManaged.has(key))
      .filter((key) => managesOwnCacheHeaders(samplePath(key)));
    expect(leaks).toEqual([]);
  });
});

describe("un singur loc pentru politica de cache", () => {
  it("nicio rută din afara listei publice nu scrie `public, …` / s-maxage de mână", () => {
    const offenders = allRouteFiles()
      .filter((file) => !(routeKey(file) in PUBLIC_ROUTES))
      .filter((file) => HAND_WRITTEN_PUBLIC.test(fs.readFileSync(file, "utf8")))
      .map(routeKey);
    expect(offenders).toEqual([]);
  }, 30_000); // scanează toate rutele — sub încărcarea suitei complete depășea 5s

  it("regula Cloudflare din docs listează toate cookie-urile de identitate", async () => {
    const { IDENTITY_COOKIES } = await import("@/lib/http/cache-policy");
    const doc = fs.readFileSync(path.resolve(__dirname, "../../docs/infra/edge-cache.md"), "utf8");
    for (const name of IDENTITY_COOKIES) expect(doc, name).toContain(`http.cookie contains "${name}="`);
  });
});
