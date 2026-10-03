import { describe, it, expect } from "vitest";
import { IngestEpisodeSchema, validateIngest } from "@/lib/movies/ingest";
import { isLicenseExpired, licenseProblems, publicAttribution, territoriesCover, type SeriesLicense } from "@/lib/movies/license";
import { isSeriesPublic } from "@/lib/movies/access";
import { targetVisibility } from "@/lib/movies/visibility";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const base = {
  title: "Sintel",
  format: "film",
  license: {
    type: "cc_by",
    attributionText: "„Sintel” © Blender Foundation | durian.blender.org — CC BY 3.0",
    sourceUrl: "https://durian.blender.org/",
    territories: ["WORLD"],
  },
};

describe("movies/ingest — validarea titlurilor ingerate", () => {
  it("un titlu CC BY complet e valid și publicabil", () => {
    const v = validateIngest(base, { territory: "RO", now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.publishBlockers).toEqual([]);
      expect(v.data.freeEpisodes).toBeGreaterThanOrEqual(0);
      expect(v.data.episodePriceCents).toBeNull();
    }
  });

  it("licența lipsă → cererea e respinsă (nu există titlu „fără licență”)", () => {
    const { license: _omit, ...noLicense } = base;
    void _omit;
    const v = validateIngest(noLicense);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/^license/);
  });

  it("tip de licență necunoscut (ex. NC) → respins", () => {
    expect(validateIngest({ ...base, license: { ...base.license, type: "cc_by_nc" } }).ok).toBe(false);
  });

  it("URL-uri doar https (sursă, poster, fișier video)", () => {
    expect(validateIngest({ ...base, license: { ...base.license, sourceUrl: "http://durian.blender.org/" } }).ok).toBe(false);
    expect(validateIngest({ ...base, posterUrl: "http://x.test/p.jpg" }).ok).toBe(false);
    expect(validateIngest({ ...base, mediaUrl: "ftp://x.test/f.mp4" }).ok).toBe(false);
    expect(validateIngest({ ...base, mediaUrl: "https://download.example.org/sintel.mp4" }).ok).toBe(true);
  });

  it("teritorii: doar WORLD, EU sau coduri ISO; normalizate la majuscule, fără duplicate", () => {
    const v = validateIngest({ ...base, license: { ...base.license, territories: ["ro", "RO", "md"] } });
    expect(v.ok && v.data.license.territories).toEqual(["RO", "MD"]);
    expect(validateIngest({ ...base, license: { ...base.license, territories: ["Romania"] } }).ok).toBe(false);
  });

  it("CC BY fără atribuire și fără sursă → salvabil ca ciornă, dar cu blocaje de publicare", () => {
    const v = validateIngest({ ...base, license: { type: "cc_by", territories: ["WORLD"] } }, { territory: "RO", now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.publishBlockers).toEqual(["attribution_required", "source_url_required"]);
  });

  it("episod: exact una dintre surse (video existent SAU fișier https)", () => {
    expect(IngestEpisodeSchema.safeParse({ title: "E1", videoId: "0b5c2c52-8a0e-4a55-9a53-6f0a0d5d1a11" }).success).toBe(true);
    expect(IngestEpisodeSchema.safeParse({ title: "E1", mediaUrl: "https://x.test/e1.mp4" }).success).toBe(true);
    expect(IngestEpisodeSchema.safeParse({ title: "E1" }).success).toBe(false);
    expect(IngestEpisodeSchema.safeParse({ title: "E1", videoId: "0b5c2c52-8a0e-4a55-9a53-6f0a0d5d1a11", mediaUrl: "https://x.test/e1.mp4" }).success).toBe(false);
  });
});

describe("movies/license — reguli de publicare", () => {
  const lic = (over: Partial<SeriesLicense>): SeriesLicense => ({
    license_type: "cc_by",
    attribution_text: "credit",
    license_source_url: "https://x.test",
    license_territories: ["WORLD"],
    license_expires_at: null,
    ...over,
  });

  it("fără tip de licență → license_required (și nimic altceva)", () => {
    expect(licenseProblems(lic({ license_type: null }), { territory: "RO", now: NOW })).toEqual(["license_required"]);
  });

  it("teritoriul trebuie să acopere teritoriul serviciului (EU acoperă RO, nu și US)", () => {
    expect(territoriesCover(["EU"], "RO")).toBe(true);
    expect(territoriesCover(["US", "CA"], "RO")).toBe(false);
    expect(licenseProblems(lic({ license_territories: ["US"] }), { territory: "RO", now: NOW })).toEqual(["territory_excludes_service"]);
    expect(licenseProblems(lic({ license_territories: [] }), { territory: "RO", now: NOW })).toEqual(["territory_required"]);
  });

  it("distribuitor: expirare obligatorie; licența expirată blochează și ascunde titlul", () => {
    expect(licenseProblems(lic({ license_type: "distributor" }), { territory: "RO", now: NOW })).toEqual(["expiry_required"]);
    const expired = "2026-01-01T00:00:00Z";
    expect(licenseProblems(lic({ license_expires_at: expired }), { territory: "RO", now: NOW })).toEqual(["license_expired"]);
    expect(isLicenseExpired(expired, NOW)).toBe(true);
    expect(isSeriesPublic({ status: "published", license_expires_at: expired }, NOW)).toBe(false);
    expect(isSeriesPublic({ status: "published", license_expires_at: null }, NOW)).toBe(true);
    expect(isSeriesPublic({ status: "draft", license_expires_at: null }, NOW)).toBe(false);
  });

  it("producție proprie: fără sursă/atribuire obligatorie; atribuirea publică apare doar dacă există", () => {
    const owned = lic({ license_type: "owned", attribution_text: null, license_source_url: null });
    expect(licenseProblems(owned, { territory: "RO", now: NOW })).toEqual([]);
    expect(publicAttribution(owned)).toBeNull();
    expect(publicAttribution(lic({}))).toEqual({ licenseType: "cc_by", text: "credit", sourceUrl: "https://x.test" });
  });
});

describe("movies/visibility — licența expirată scoate și episoadele gratuite din feed", () => {
  it("episod gratuit al unui titlu publicat → public; după expirarea licenței → private", () => {
    const ep = { episode_number: 1, status: "published" as const };
    expect(targetVisibility({ status: "published", free_episodes: 3, license_expires_at: null }, ep, NOW)).toBe("public");
    expect(targetVisibility({ status: "published", free_episodes: 3, license_expires_at: "2026-01-01T00:00:00Z" }, ep, NOW)).toBe("private");
  });
});
