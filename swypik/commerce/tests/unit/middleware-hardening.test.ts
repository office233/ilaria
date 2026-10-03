import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const intl = vi.hoisted(() => ({ impl: (_req: unknown) => NextResponse.next() }));
vi.mock("next-intl/middleware", () => ({ default: () => (req: unknown) => intl.impl(req) }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://swypik.com" }));
vi.mock("@/lib/storage/config", () => ({ mediaCspOrigins: () => [] }));

import { config, middleware, STATIC_FILE_EXTENSIONS } from "@/middleware";
import { resetAdminSessionCache } from "@/lib/admin/edge-session";

const GOOD_TOKEN = "a".repeat(64);

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, { method: init.method ?? "GET", headers: init.headers });
}

beforeEach(() => {
  resetAdminSessionCache();
  intl.impl = () => NextResponse.next();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("host canonic", () => {
  it("www → apex cu 308, păstrând calea și query-ul", async () => {
    const res = await middleware(req("https://www.swypik.com/en/shop?q=1", { headers: { host: "www.swypik.com" } }));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://swypik.com/en/shop?q=1");
  });

  it("http (X-Forwarded-Proto de la Cloudflare) → https", async () => {
    const res = await middleware(
      req("http://swypik.com/help", { headers: { host: "swypik.com", "x-forwarded-proto": "http" } }),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://swypik.com/help");
  });

  it("cererile locale (healthcheck pe 127.0.0.1) nu sunt redirecționate", async () => {
    const res = await middleware(req("http://127.0.0.1:3000/", { headers: { host: "127.0.0.1:3000" } }));
    expect(res.status).toBe(200);
  });
});

describe("admin_token validat devreme", () => {
  it("token cu formă greșită → /admin și cookie șters, fără fetch (inclusiv RSC)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await middleware(
      req("https://swypik.com/admin/payouts", { headers: { host: "swypik.com", cookie: "admin_token=probe", RSC: "1" } }),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin");
    expect(res.headers.get("set-cookie")).toMatch(/admin_token=;.*Max-Age=0/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("token bine format dar necunoscut serverului (401) → /admin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const res = await middleware(
      req("https://swypik.com/admin/refunds", { headers: { host: "swypik.com", cookie: `admin_token=${GOOD_TOKEN}` } }),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin");
  });

  it("sesiune validă → trece, cu CSP nonce; rezultatul e ținut în cache", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const mk = () =>
      req("https://swypik.com/admin/users", { headers: { host: "swypik.com", cookie: `admin_token=${GOOD_TOKEN}` } });
    const res = await middleware(mk());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("nonce-");
    await middleware(mk());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("verificarea indisponibilă → trece mai departe (garda paginii decide)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const res = await middleware(
      req("https://swypik.com/admin/users", { headers: { host: "swypik.com", cookie: `admin_token=${GOOD_TOKEN}` } }),
    );
    expect(res.status).toBe(200);
  });

  it("HEAD pe /admin primește și el CSP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const res = await middleware(
      req("https://swypik.com/admin/users", {
        method: "HEAD",
        headers: { host: "swypik.com", cookie: `admin_token=${GOOD_TOKEN}` },
      }),
    );
    expect(res.headers.get("content-security-policy")).toContain("nonce-");
  });
});

describe("cookie-ul de limbă doar când se schimbă", () => {
  const withLocaleCookie = () => {
    const r = NextResponse.next();
    r.cookies.set("swypik_locale", "ro", { path: "/" });
    r.cookies.set("other", "1", { path: "/" });
    return r;
  };

  it("fără cookie, pe o rută fără prefix: nu trimite swypik_locale (răspuns cacheabil)", async () => {
    intl.impl = withLocaleCookie;
    const res = await middleware(req("https://swypik.com/", { headers: { host: "swypik.com", "accept-language": "en" } }));
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("swypik_locale="))).toBe(false);
    expect(cookies.some((c) => c.startsWith("other="))).toBe(true);
  });

  it("pe o rută cu prefix (/en) alegerea explicită se păstrează", async () => {
    intl.impl = () => {
      const r = NextResponse.next();
      r.cookies.set("swypik_locale", "en", { path: "/" });
      return r;
    };
    const res = await middleware(req("https://swypik.com/en/help", { headers: { host: "swypik.com" } }));
    expect(res.headers.getSetCookie().some((c) => c.startsWith("swypik_locale=en"))).toBe(true);
  });
});

describe("rute non-localizate și API", () => {
  it("/.well-known/* nu trece prin next-intl", async () => {
    const spy = vi.fn(() => NextResponse.next());
    intl.impl = spy;
    await middleware(req("https://swypik.com/.well-known/apple-app-site-association", { headers: { host: "swypik.com" } }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("playlist HLS din /api: no-store implicit, dar proxy-ul media își pune singur antetele", async () => {
    const api = await middleware(req("https://swypik.com/api/profile/x.m3u8", { headers: { host: "swypik.com" } }));
    expect(api.headers.get("cache-control")).toBe("private, no-store");
    const media = await middleware(
      req("https://swypik.com/api/movies/stream/tok/seg0.ts", { headers: { host: "swypik.com" } }),
    );
    expect(media.headers.get("cache-control")).toBeNull();
  });
});

describe("matcher", () => {
  const re = new RegExp(`^${config.matcher[0]}$`);
  it("usernames cu punct și /api/*.m3u8 trec prin middleware", () => {
    expect(re.test("/u/zz.qq")).toBe(true);
    expect(re.test("/en/u/ana.maria")).toBe(true);
    expect(re.test("/api/movies/stream/t/index.m3u8")).toBe(true);
    expect(re.test("/api/sitemap.xml")).toBe(true);
    expect(re.test("/.well-known/apple-app-site-association")).toBe(true);
  });
  it("fișierele statice reale rămân excluse", () => {
    for (const p of ["/favicon.svg", "/icon-192.png", "/manifest.json", "/robots.txt", "/sitemap.xml", "/_next/static/chunks/a.js", "/_next/image"]) {
      expect(re.test(p), p).toBe(false);
    }
  });
  it("lista de extensii exportată e aceeași cu cea din matcher", () => {
    const inMatcher = config.matcher[0].match(/\(\?:([a-z0-9|]+)\)\$/)![1].split("|");
    expect([...inMatcher].sort()).toEqual([...STATIC_FILE_EXTENSIONS].sort());
  });
});
