import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery: mocks.db }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: mocks.limit, getClientIP: () => "ip" }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://swypik.com" }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { GET, POST } from "@/app/api/unsubscribe/route";
import { encodeEmailParam, unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "test-only-secret");
  mocks.limit.mockResolvedValue({ success: true });
  mocks.db.mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllEnvs());

const email = "User@Example.com";

describe("unsubscribe", () => {
  it("a GET (link scanner) never unsubscribes and never puts the address in clear", async () => {
    const t = unsubscribeToken(email);
    const res = await GET(new Request(`https://swypik.com/api/unsubscribe?email=${encodeURIComponent(email)}&t=${t}`));
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("https://swypik.com/unsubscribe?u=");
    expect(loc).not.toContain("Example.com");
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it("the confirmation link points to the confirm page, not the API", () => {
    expect(unsubscribeUrl(email, "en")).toMatch(/^https:\/\/swypik\.com\/unsubscribe\?u=.+&t=[0-9a-f]{32}&l=en$/);
  });

  it("one-click POST with a valid token unsubscribes and turns marketing consent off", async () => {
    const u = encodeEmailParam(email);
    const res = await POST(new Request(`https://swypik.com/api/unsubscribe?u=${u}&t=${unsubscribeToken(email)}`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(mocks.db.mock.calls[0][0]).toContain("INSERT INTO email_unsubscribes");
    expect(mocks.db.mock.calls[0][1]).toEqual(["user@example.com"]);
    expect(mocks.db.mock.calls[1][0]).toContain("email_marketing = false");
  });

  it("the confirm-page form redirects to the done state", async () => {
    const body = new URLSearchParams({ u: encodeEmailParam(email), t: unsubscribeToken(email), l: "fr", form: "1" });
    const res = await POST(
      new Request("https://swypik.com/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://swypik.com/unsubscribe?done=1&l=fr");
  });

  it("rejects a forged token without touching the database", async () => {
    const res = await POST(new Request(`https://swypik.com/api/unsubscribe?u=${encodeEmailParam(email)}&t=${"0".repeat(32)}`, { method: "POST" }));
    expect(res.status).toBe(403);
    expect(mocks.db).not.toHaveBeenCalled();
    expect(verifyUnsubscribeToken(email, "short")).toBe(false);
  });
});
