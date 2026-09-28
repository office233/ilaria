/**
 * Sesiuni de admin per administrator (lib/security/admin-auth.ts):
 * rezolvare din cookie/Bearer, creare legată de user_id, TTL, break-glass,
 * RBAC (permissions) și gărzile requireAdmin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  calls: [] as { sql: string; params: unknown[] }[],
  rows: [] as unknown[],
  cookie: undefined as string | undefined,
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    return { rows: h.rows, rowCount: h.rows.length };
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "admin_token" && h.cookie ? { value: h.cookie } : undefined) }),
}));

import {
  createAdminSessionAndGetCookie,
  getAdminActor,
  getAdminActorFromRequest,
  isBreakGlassEnabled,
  revokeAdminSessionsForUser,
} from "@/lib/security/admin-auth";
import { requireAdmin } from "@/lib/admin/guard";
import { hasPermission, normalizeAdminRole, permissionsFor } from "@/lib/admin/permissions";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION_ROW = { token: "hash", kind: "otp", user_id: "u-1", email: "a@x.ro", username: "ana", admin_role: "moderator" };

const env = { ...process.env };
beforeEach(() => {
  h.calls = [];
  h.rows = [];
  h.cookie = undefined;
  process.env.ADMIN_SECRET = "machine-secret-0123456789";
  delete process.env.ADMIN_BREAK_GLASS_ENABLED;
  delete process.env.ADMIN_SESSION_TTL_HOURS;
});
afterEach(() => {
  process.env = { ...env };
});

describe("session resolution", () => {
  it("resolves the cookie to a named admin, checking role, suspension and revocation in SQL", async () => {
    h.rows = [SESSION_ROW];
    const actor = await getAdminActorFromRequest(
      new Request("http://x/api/admin/y", { headers: { cookie: "foo=1; admin_token=tok123" } }),
    );
    expect(actor).toMatchObject({ kind: "admin_user", userId: "u-1", role: "moderator", email: "a@x.ro" });
    expect(h.calls[0].params).toEqual([sha("tok123")]);
    const sql = h.calls[0].sql;
    expect(sql).toContain("u.role = 'admin'");
    expect(sql).toContain("suspended_until");
    expect(sql).toContain("revoked_at IS NULL");
  });

  it("no cookie / unknown session → null; break-glass sessions are labelled", async () => {
    expect(await getAdminActorFromRequest(new Request("http://x"))).toBeNull();
    h.rows = [];
    expect(await getAdminActorFromRequest(new Request("http://x", { headers: { cookie: "admin_token=zzz" } }))).toBeNull();
    h.rows = [{ ...SESSION_ROW, kind: "break_glass" }];
    h.cookie = "abc";
    expect((await getAdminActor())?.kind).toBe("break_glass");
  });

  it("Bearer ADMIN_SECRET is a machine actor (no DB lookup); a wrong secret is not", async () => {
    const ok = await getAdminActorFromRequest(
      new Request("http://x", { headers: { authorization: "Bearer machine-secret-0123456789" } }),
    );
    expect(ok).toMatchObject({ kind: "machine", role: "machine", userId: null });
    const bad = await getAdminActorFromRequest(new Request("http://x", { headers: { authorization: "Bearer nope" } }));
    expect(bad).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it("an unknown admin_role degrades to the most restricted role", () => {
    expect(normalizeAdminRole(null)).toBe("support");
    expect(normalizeAdminRole("root")).toBe("support");
    expect(normalizeAdminRole("finance")).toBe("finance");
  });
});

describe("session creation", () => {
  it("stores only the hash, binds the user, defaults to a 12h TTL", async () => {
    const cookie = await createAdminSessionAndGetCookie({ userId: "u-9" });
    const token = /admin_token=([0-9a-f]+);/.exec(cookie)?.[1] ?? "";
    expect(token).toHaveLength(64);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Max-Age=${12 * 3600}`);
    const [hash, userId, kind, , , ttl] = h.calls[0].params;
    expect(hash).toBe(sha(token));
    expect(userId).toBe("u-9");
    expect(kind).toBe("otp");
    expect(ttl).toBe(12);
    expect(h.calls[0].params).not.toContain(token);
  });

  it("honours ADMIN_SESSION_TTL_HOURS within bounds", async () => {
    process.env.ADMIN_SESSION_TTL_HOURS = "4";
    expect(await createAdminSessionAndGetCookie({ userId: "u", kind: "break_glass" })).toContain(`Max-Age=${4 * 3600}`);
    process.env.ADMIN_SESSION_TTL_HOURS = "99999";
    expect(await createAdminSessionAndGetCookie({ userId: "u" })).toContain(`Max-Age=${12 * 3600}`);
  });

  it("revokes every session of a user", async () => {
    await revokeAdminSessionsForUser("u-3");
    expect(h.calls[0].sql).toContain("UPDATE admin_sessions SET revoked_at");
    expect(h.calls[0].params).toEqual(["u-3"]);
  });

  it("break-glass needs the explicit flag AND a secret", () => {
    expect(isBreakGlassEnabled()).toBe(false);
    process.env.ADMIN_BREAK_GLASS_ENABLED = "1";
    expect(isBreakGlassEnabled()).toBe(true);
    delete process.env.ADMIN_SECRET;
    expect(isBreakGlassEnabled()).toBe(false);
  });
});

describe("RBAC", () => {
  it("only owners manage admins; machines can do everything else", () => {
    expect(hasPermission("owner", "admins.manage")).toBe(true);
    for (const r of ["ops", "finance", "moderator", "support", "machine"] as const) {
      expect(hasPermission(r, "admins.manage")).toBe(false);
    }
    expect(hasPermission("machine", "finance")).toBe(true);
    expect(hasPermission("moderator", "finance")).toBe(false);
    expect(hasPermission("finance", "moderation")).toBe(false);
    expect(permissionsFor("support")).toContain("users.manage");
  });

  it("requireAdmin → 401 without a session, 403 without the permission, actor otherwise", async () => {
    const anon = await requireAdmin(new Request("http://x"), "moderation");
    expect((anon as Response).status).toBe(401);
    h.rows = [{ ...SESSION_ROW, admin_role: "finance" }];
    const req = () => new Request("http://x", { headers: { cookie: "admin_token=t" } });
    expect(((await requireAdmin(req(), "moderation")) as Response).status).toBe(403);
    expect(await requireAdmin(req(), "finance")).toMatchObject({ userId: "u-1", role: "finance" });
  });
});
