import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: null as string | null,
  dbQuery: vi.fn(),
}));

vi.mock("@/lib/social/session", () => ({
  getOptionalSocialUserId: async () => h.userId,
  getOrCreateSocialUser: vi.fn(),
  setAnonSessionCookie: vi.fn(),
  anonSessionErrorResponse: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
  getClientIP: () => "203.0.113.10",
}));
vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  dbQuery: h.dbQuery,
}));

import { DELETE } from "@/app/api/notifications/subscribe/route";

function request(endpoint = "https://push.example/subscription-1"): Request {
  return new Request("https://swypik.com/api/notifications/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

beforeEach(() => {
  h.userId = null;
  h.dbQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("push unsubscribe ownership", () => {
  it("does not mutate subscriptions when no verified social identity exists", async () => {
    const res = await DELETE(request());
    expect(res.status).toBe(200);
    expect(h.dbQuery).not.toHaveBeenCalled();
  });

  it("revokes only the endpoint owned by the verified user", async () => {
    h.userId = "11111111-1111-4111-8111-111111111111";
    const endpoint = "https://push.example/subscription-2";
    const res = await DELETE(request(endpoint));
    expect(res.status).toBe(200);
    expect(h.dbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = h.dbQuery.mock.calls[0];
    expect(String(sql)).toContain("WHERE endpoint = $1 AND user_id = $2");
    expect(params).toEqual([endpoint, h.userId]);
  });
});
