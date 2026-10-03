import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({ query: vi.fn(), cookies: new Map<string, string>() }));
vi.mock("@/lib/db", () => ({ dbQuery: h.query }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => h.cookies.has(name) ? { value: h.cookies.get(name) } : undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
import { getAuthUser, getSessionUserId } from "@/lib/auth/getAuthUser";
import { resolveAdminSessionToken } from "@/lib/security/admin-auth";

const TOKEN = "a".repeat(64);
beforeEach(() => {
  h.cookies.clear();
  h.query.mockReset().mockResolvedValue({ rows: [] });
});

describe("unified auth security boundaries", () => {
  it.each(["otp:123456", "not-a-session", "a".repeat(63)])("never treats %s as a seller session", async (value) => {
    h.cookies.set("seller_session", value);
    expect((await getAuthUser()).role).toBe("guest");
    expect(h.query).not.toHaveBeenCalled();
  });

  it("checks current seller approval and hashes the session token", async () => {
    h.cookies.set("seller_session", TOKEN);
    h.query.mockResolvedValue({ rows: [{ seller_id: "seller-1" }] });
    expect((await getAuthUser()).sellerId).toBe("seller-1");
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).toContain("JOIN sellers s ON s.id = ss.seller_id");
    expect(sql).toContain("s.status IN ('approved', 'active')");
    expect(params).toEqual([createHash("sha256").update(TOKEN).digest("hex")]);
  });

  it.each([getAuthUser, getSessionUserId])("requires an unrestricted account when resolving the user cookie", async (resolve) => {
    h.cookies.set("swypik_session", TOKEN);
    await resolve();
    const [sql] = h.query.mock.calls[0];
    expect(sql).toContain("COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')");
    expect(sql).toContain("u.suspended_until IS NULL OR u.suspended_until <= now()");
    expect(sql).toContain("s.revoked_at IS NULL");
  });

  it("requires an unrestricted account for the dedicated admin session too", async () => {
    await expect(resolveAdminSessionToken(TOKEN)).resolves.toBeNull();
    const [sql] = h.query.mock.calls[0];
    expect(sql).toContain("COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')");
    expect(sql).toContain("u.suspended_until IS NULL OR u.suspended_until <= now()");
    expect(sql).toContain("u.role = 'admin'");
  });
});
