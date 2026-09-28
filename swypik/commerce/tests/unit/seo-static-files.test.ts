import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cats = vi.hoisted(() => ({ tree: [] as unknown[], fail: false }));
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://swypik.com" }));
vi.mock("@/lib/shop/categories", () => ({
  getShopCategories: vi.fn(async () => {
    if (cats.fail) throw new Error("db down");
    return cats.tree;
  }),
}));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: (f: string) => flags.on.has(f) }));

import { GET as staticSitemap } from "@/app/static-sitemap.xml/route";
import { flattenCategoryIds } from "@/lib/seo/sitemap-categories";
import { androidAssetLinks, appleAppSiteAssociation } from "@/lib/mobile/app-links";
import { GET as aasaRoute } from "@/app/.well-known/apple-app-site-association/route";
import { GET as assetLinksRoute } from "@/app/.well-known/assetlinks.json/route";

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

beforeEach(() => {
  cats.fail = false;
  cats.tree = [
    { id: "department:fashion", name: "Modă", children: [{ id: "fashion-dresses", name: "Rochii" }] },
    { id: "electronics", name: "Electronice" },
  ];
  flags.on = new Set();
  vi.unstubAllEnvs();
});

describe("static-sitemap", () => {
  it("categoriile vin din arborele real (aceleași id-uri ca /categories/[slug])", async () => {
    const xml = await (await staticSitemap()).text();
    const urls = locs(xml);
    expect(urls).toContain("https://swypik.com/categories/department%3Afashion");
    expect(urls).toContain("https://swypik.com/categories/fashion-dresses");
    expect(urls).toContain("https://swypik.com/categories/electronics");
    // slug-urile vechi hardcodate (404 live) au dispărut
    expect(urls).not.toContain("https://swypik.com/categories/fashion");
  });

  it("fără /unsubscribe și fără module oprite; modulele pornite apar", async () => {
    let urls = locs(await (await staticSitemap()).text());
    expect(urls.some((u) => u.includes("/unsubscribe"))).toBe(false);
    expect(urls).not.toContain("https://swypik.com/music");
    flags.on = new Set(["music"]);
    urls = locs(await (await staticSitemap()).text());
    expect(urls).toContain("https://swypik.com/music");
  });

  it("DB indisponibil → sitemap valid fără categorii", async () => {
    cats.fail = true;
    const res = await staticSitemap();
    expect(res.status).toBe(200);
    expect(locs(await res.text()).some((u) => u.includes("/categories/"))).toBe(false);
  });

  it("flattenCategoryIds deduplică", () => {
    expect(flattenCategoryIds([{ id: "a", name: "A", children: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }])).toEqual(["a", "b"]);
  });
});

describe("robots.txt", () => {
  const robots = fs.readFileSync(path.resolve(__dirname, "../../public/robots.txt"), "utf8");
  it("nu blochează /_next/ (Google randează cu JS/CSS)", () => {
    expect(robots).not.toMatch(/^Disallow:\s*\/_next/m);
  });
  it("blochează și variantele localizate ale paginilor private", () => {
    for (const l of ["en", "es", "fr", "de", "pt", "it"]) {
      expect(robots).toContain(`Disallow: /${l}/checkout`);
      expect(robots).toContain(`Disallow: /${l}/account`);
    }
  });
});

describe(".well-known din env", () => {
  const SHA = Array.from({ length: 32 }, () => "AB").join(":");

  it("fără env → 404", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "");
    vi.stubEnv("IOS_BUNDLE_IDS", "");
    vi.stubEnv("ANDROID_APP_LINKS", "");
    expect((await aasaRoute()).status).toBe(404);
    expect((await assetLinksRoute()).status).toBe(404);
  });

  it("AASA: appIDs = TEAM.bundle, back-office exclus", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "ABCDE12345");
    vi.stubEnv("IOS_BUNDLE_IDS", "com.swypik.app, com.swypik.courier");
    const res = await aasaRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.swypik.app", "ABCDE12345.com.swypik.courier"]);
    expect(body.applinks.details[0].components).toContainEqual({ "/": "/admin/*", exclude: true });
  });

  it("assetlinks: pachet + amprente valide; intrările greșite sunt ignorate", async () => {
    vi.stubEnv("ANDROID_APP_LINKS", `com.swypik.app=${SHA.toLowerCase()};bad pkg=${SHA};com.swypik.go=nothex`);
    const res = await assetLinksRoute();
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].target).toEqual({ namespace: "android_app", package_name: "com.swypik.app", sha256_cert_fingerprints: [SHA] });
  });

  it("team id invalid → null", () => {
    expect(appleAppSiteAssociation({ APPLE_TEAM_ID: "short", IOS_BUNDLE_IDS: "com.a.b" })).toBeNull();
    expect(androidAssetLinks({})).toBeNull();
  });
});
