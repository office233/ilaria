import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// next-intl/middleware importă `next/server` fără extensie (ESM) — irelevant aici.
vi.mock("next-intl/middleware", () => ({ default: () => () => new Response(null) }));
vi.mock("@/lib/i18n/routing", () => ({ routing: {} }));
import {
  CACHE_PROFILES,
  IDENTITY_COOKIES,
  NO_STORE,
  PUBLIC_ROUTES,
  applyCachePolicy,
  applyNoStore,
  cacheControlValue,
  hasUrlPreferences,
  isAnonymousRequest,
} from "@/lib/http/cache-policy";
import { middleware } from "@/middleware";

function req(cookie?: string): Request {
  return new Request("https://swypik.test/api/x", { headers: cookie ? { cookie } : {} });
}

describe("cache-policy — profile", () => {
  it("fiecare profil are s-maxage > 0 și stale-while-revalidate ≥ s-maxage", () => {
    for (const [name, p] of Object.entries(CACHE_PROFILES)) {
      expect(p.sMaxAge, name).toBeGreaterThan(0);
      expect(p.staleWhileRevalidate, name).toBeGreaterThanOrEqual(p.sMaxAge);
      expect(p.maxAge, name).toBeLessThanOrEqual(p.sMaxAge);
    }
  });

  it("formatează antetul standard", () => {
    const p = CACHE_PROFILES.list;
    expect(cacheControlValue("list")).toBe(
      `public, max-age=${p.maxAge}, s-maxage=${p.sMaxAge}, stale-while-revalidate=${p.staleWhileRevalidate}`,
    );
  });

  it("fiecare rută publică folosește un profil existent", () => {
    for (const [route, rule] of Object.entries(PUBLIC_ROUTES)) {
      expect(CACHE_PROFILES[rule.profile], route).toBeDefined();
    }
  });
});

describe("cache-policy — anonim vs identificat", () => {
  it("fără cookie sau doar cu cookie-uri neutre = anonim", () => {
    expect(isAnonymousRequest(req())).toBe(true);
    expect(isAnonymousRequest(req("swypik_locale=en; swypik_currency=EUR; cookie_consent=1"))).toBe(true);
  });

  it("orice cookie de identitate = neanonim", () => {
    for (const name of IDENTITY_COOKIES) {
      expect(isAnonymousRequest(req(`swypik_locale=ro; ${name}=abc`)), name).toBe(false);
    }
  });

  it("nu confundă un cookie al cărui nume doar conține numele de sesiune", () => {
    expect(isAnonymousRequest(req("not_swypik_session_hint=1"))).toBe(true);
  });
});

describe("applyCachePolicy", () => {
  it("200 pe rută publică → public cu s-maxage, fără CDN-Cache-Control și fără Vary: Cookie", () => {
    const res = new Response("{}", { headers: { "CDN-Cache-Control": "public, max-age=999", Vary: "Cookie" } });
    applyCachePolicy(res, "news", req("swypik_session=x"));
    expect(res.headers.get("cache-control")).toBe(cacheControlValue(PUBLIC_ROUTES.news.profile));
    expect(res.headers.get("cdn-cache-control")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("erorile și 429 nu intră niciodată în cache", () => {
    for (const status of [400, 404, 429, 500]) {
      const res = applyCachePolicy(new Response("x", { status }), "news", req());
      expect(res.headers.get("cache-control"), String(status)).toBe(NO_STORE);
    }
  });

  it("un răspuns cu Set-Cookie nu e public", () => {
    const res = new Response("{}", { headers: { "set-cookie": "a=b" } });
    expect(applyCachePolicy(res, "news", req()).headers.get("cache-control")).toBe(NO_STORE);
  });

  it("audiența anonimă: public fără sesiune, private cu sesiune", () => {
    expect(PUBLIC_ROUTES["music/home"].audience).toBe("anonymous");
    const anon = applyCachePolicy(new Response("{}"), "music/home", req());
    expect(anon.headers.get("cache-control")).toContain("s-maxage=");
    const authed = applyCachePolicy(new Response("{}"), "music/home", req("swypik_session=tok"));
    expect(authed.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("applyNoStore marchează explicit per-utilizator", () => {
    const res = applyNoStore(new Response("{}", { headers: { "Cache-Control": "public, s-maxage=60" } }));
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });
});

describe("hasUrlPreferences", () => {
  it("cere și limba și moneda în query", () => {
    expect(hasUrlPreferences(new URL("https://x/api/products?locale=ro&currency=RON"))).toBe(true);
    expect(hasUrlPreferences(new URL("https://x/api/products?locale=ro"))).toBe(false);
    expect(hasUrlPreferences(new URL("https://x/api/products?currency=EUR"))).toBe(false);
  });
});

describe("middleware — implicit private, no-store pe /api", () => {
  it("GET /api/* primește private, no-store (rutele publice îl înlocuiesc)", async () => {
    const res = await middleware(new NextRequest("https://swypik.test/api/auth/me"));
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("HEAD la fel; POST neatins", async () => {
    const head = await middleware(new NextRequest("https://swypik.test/api/cart", { method: "HEAD" }));
    expect(head.headers.get("cache-control")).toBe(NO_STORE);
    const post = await middleware(new NextRequest("https://swypik.test/api/vitals", { method: "POST" }));
    expect(post.headers.get("cache-control")).toBeNull();
  });

  it("rutele publice și ISR nu primesc default (antetul din middleware ar câștiga în fața handler-ului)", async () => {
    for (const path of ["/api/news", "/api/videos/7f1c/captions", "/api/products/abc", "/api/fx"]) {
      const res = await middleware(new NextRequest(`https://swypik.test${path}`));
      expect(res.headers.get("cache-control"), path).toBeNull();
    }
    // frate static al unei rute dinamice publice, per-utilizator
    const save = await middleware(new NextRequest("https://swypik.test/api/products/abc/save"));
    expect(save.headers.get("cache-control")).toBe(NO_STORE);
});
});
