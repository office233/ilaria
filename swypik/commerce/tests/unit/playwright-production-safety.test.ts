import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configFor(url: string, allowProd: string) {
  vi.stubEnv("PLAYWRIGHT_BASE_URL", url);
  vi.stubEnv("ALLOW_PROD_E2E", allowProd);
  vi.resetModules();
  return (await import("../../playwright.config")).default;
}

describe("browser test production boundary", () => {
  it("rejects production without explicit smoke opt-in", async () => {
    await expect(configFor("https://swypik.com", "0")).rejects.toThrow("PRODUCȚIEI");
  });

  it.each(["https://swypik.com", "https://www.swypik.com"])(
    "never exposes mutating full projects for %s even when smoke is allowed",
    async (url) => {
      const config = await configFor(url, "1");
      expect(config.projects?.map((project) => project.name)).toEqual(["mobile", "desktop"]);
    },
  );

  it("keeps full projects available for the isolated local stack", async () => {
    const config = await configFor("http://localhost:3000", "0");
    expect(config.projects?.map((project) => project.name)).toEqual([
      "mobile", "desktop", "full-desktop", "full-mobile",
    ]);
  });
});
