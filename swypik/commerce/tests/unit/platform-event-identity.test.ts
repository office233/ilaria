import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  readAnonId: vi.fn(),
  getOrCreateAnonId: vi.fn(),
}));

vi.mock("@/lib/auth/getAuthUser", () => ({
  getSessionUserId: h.getSessionUserId,
}));
vi.mock("@/lib/anon/session", () => ({
  readAnonId: h.readAnonId,
  getOrCreateAnonId: h.getOrCreateAnonId,
}));
vi.mock("@/lib/security/secret-box", () => ({
  deriveServerSecret: (_purpose: string, input: string) =>
    `0123456789abcdef0123456789abcdef0123456789abcdef:${input}`,
}));

import { resolvePlatformEventIdentity } from "@/lib/events/platform-identity";

beforeEach(() => {
  h.getSessionUserId.mockReset().mockResolvedValue(null);
  h.readAnonId.mockReset().mockResolvedValue(null);
  h.getOrCreateAnonId.mockReset().mockResolvedValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

describe("resolvePlatformEventIdentity", () => {
  it("binds real accounts to the authenticated session user id", async () => {
    h.getSessionUserId.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    const identity = await resolvePlatformEventIdentity();
    expect(identity.actorId).toBe("11111111-1111-4111-8111-111111111111");
    expect(identity.kind).toBe("user");
    expect(identity.sessionId).toMatch(/^u_[a-z0-9]{48}$/);
    expect(h.getOrCreateAnonId).not.toHaveBeenCalled();
  });

  it("keeps anonymous traffic explicitly anonymous with a server pseudonym", async () => {
    const identity = await resolvePlatformEventIdentity();
    expect(identity.actorId).toBeNull();
    expect(identity.kind).toBe("anonymous");
    expect(identity.sessionId).toMatch(/^a_[a-z0-9]{48}$/);
    expect(identity.rateLimitKey).toContain(identity.sessionId);
  });
});
