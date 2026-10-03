import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
function configure() {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://swypik.com");
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "");
}

describe("public URL separation without traffic migration", () => {
  it("keeps all current defaults on the deployed application", async () => {
    configure();
    const urls = await import("@/lib/app-url");
    expect([urls.APP_URL, urls.SITE_URL, urls.API_URL]).toEqual(Array(3).fill("https://swypik.com"));
  });
  it("lets the presentation origin differ without changing app or API links", async () => {
    configure();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.swypik.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://swypik.com/");
    const urls = await import("@/lib/app-url");
    expect(urls.SITE_URL).toBe("https://swypik.com");
    expect(urls.APP_URL).toBe("https://app.swypik.com");
    expect(urls.API_URL).toBe("https://app.swypik.com");
  });
  it("permits a deliberately configured common API origin", async () => {
    configure();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.swypik.com");
    expect((await import("@/lib/app-url")).API_URL).toBe("https://api.swypik.com");
  });
  it.each(["https://user:secret@api.swypik.com", "https://api.swypik.com/api", "http://localhost:8081"])("fails closed for invalid API configuration %s", async (value) => {
    configure();
    vi.stubEnv("NEXT_PUBLIC_API_URL", value);
    await expect(import("@/lib/app-url")).rejects.toThrow("NEXT_PUBLIC_API_URL must be a valid HTTPS origin");
  });
});
