import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({ default: () => () => NextResponse.next() }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://app.swypik.com" }));
vi.mock("@/lib/storage/config", () => ({ mediaCspOrigins: () => [] }));
import { middleware } from "@/middleware";

afterEach(() => vi.unstubAllEnvs());
function request(origin: string) {
  return new NextRequest("https://app.swypik.com/api/profile", {
    method: "POST",
    headers: { origin, cookie: "swypik_session=test-session" },
  });
}

describe("middleware application origin boundary", () => {
  it("rejects cookie-authenticated mutation from a separately configured presentation site", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://swypik.com");
    vi.stubEnv("ALLOWED_ORIGINS_EXTRA", "");
    expect((await middleware(request("https://swypik.com"))).status).toBe(403);
  });
  it("accepts same-origin application mutation", async () => {
    vi.stubEnv("ALLOWED_ORIGINS_EXTRA", "");
    expect((await middleware(request("https://app.swypik.com"))).status).toBe(200);
  });
  it("permits a reviewed explicitly configured extra origin", async () => {
    vi.stubEnv("ALLOWED_ORIGINS_EXTRA", "https://swypik.com");
    expect((await middleware(request("https://swypik.com"))).status).toBe(200);
  });
  it("rejects HTTP loopback trust in production even as an extra", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS_EXTRA", "http://localhost:8081");
    expect((await middleware(request("http://localhost:8081"))).status).toBe(403);
  });
});
