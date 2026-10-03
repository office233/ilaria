import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "https://swypik.example";

async function load() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", BASE);
  vi.stubEnv("APP_URL", "");
  return import("@/lib/seo/hreflang");
}

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("localizedUrl", () => {
  it("gives the default locale (ro) no prefix", async () => {
    const { localizedUrl } = await load();
    expect(localizedUrl("ro", "/help")).toBe(`${BASE}/help`);
    expect(localizedUrl("ro", "/")).toBe(`${BASE}/`);
  });

  it("prefixes other locales, without a trailing slash on the root", async () => {
    const { localizedUrl } = await load();
    expect(localizedUrl("en", "/help")).toBe(`${BASE}/en/help`);
    expect(localizedUrl("de", "/product/123")).toBe(`${BASE}/de/product/123`);
    expect(localizedUrl("fr", "/")).toBe(`${BASE}/fr`);
  });

  it("normalises a path without a leading slash and falls back to ro for unknown locales", async () => {
    const { localizedUrl } = await load();
    expect(localizedUrl("it", "news")).toBe(`${BASE}/it/news`);
    expect(localizedUrl("xx", "/news")).toBe(`${BASE}/news`);
  });
});

describe("localizedAlternates", () => {
  it("self-canonicalises each locale and lists hreflang for all of them", async () => {
    const { localizedAlternates } = await load();
    const ro = localizedAlternates("ro", "/news/abc");
    const en = localizedAlternates("en", "/news/abc");

    // News used to point at /ro/news (a 307) — the default locale has no prefix.
    expect(ro.canonical).toBe(`${BASE}/news/abc`);
    expect(en.canonical).toBe(`${BASE}/en/news/abc`);

    expect(en.languages).toEqual(ro.languages);
    expect(en.languages).toMatchObject({
      ro: `${BASE}/news/abc`,
      en: `${BASE}/en/news/abc`,
      es: `${BASE}/es/news/abc`,
      fr: `${BASE}/fr/news/abc`,
      de: `${BASE}/de/news/abc`,
      pt: `${BASE}/pt/news/abc`,
      it: `${BASE}/it/news/abc`,
      "x-default": `${BASE}/news/abc`,
    });
  });

  it("never points a child page at the homepage", async () => {
    const { localizedAlternates } = await load();
    for (const path of ["/fly", "/missions", "/search"]) {
      expect(localizedAlternates("ro", path).canonical).toBe(`${BASE}${path}`);
      expect(localizedAlternates("es", path).canonical).toBe(`${BASE}/es${path}`);
    }
  });

  it("keeps the canonical inside the hreflang set", async () => {
    const { localizedAlternates } = await load();
    for (const locale of ["ro", "en", "pt"]) {
      const a = localizedAlternates(locale, "/");
      expect(Object.values(a.languages)).toContain(a.canonical);
    }
  });
});
