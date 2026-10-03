/**
 * /api/admin/login (acces de urgență) și /api/admin/logout.
 * ADMIN_SECRET nu mai e parolă pentru oameni: fără ADMIN_BREAK_GLASS_ENABLED=1
 * ruta refuză; cu flag, cere secretul + emailul unui admin existent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { auditInserts, type SqlCall } from "./helpers/admin-actors";

const h = vi.hoisted(() => ({
  calls: [] as { sql: string; params: unknown[] }[],
  adminRows: [] as unknown[],
  sessionRows: [] as unknown[],
  allowed: true,
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    if (sql.includes("FROM users") && sql.includes("lower(email)")) return { rows: h.adminRows, rowCount: h.adminRows.length };
    if (sql.includes("FROM admin_sessions s")) return { rows: h.sessionRows, rowCount: h.sessionRows.length };
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: h.allowed }),
  getClientIP: () => "10.0.0.9",
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as login } from "@/app/api/admin/login/route";
import { POST as logout } from "@/app/api/admin/logout/route";

const SECRET = "break-glass-secret-0123456789";
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const audit = () => auditInserts(h.calls as SqlCall[]);

const env = { ...process.env };
beforeEach(() => {
  h.calls = [];
  h.adminRows = [];
  h.sessionRows = [];
  h.allowed = true;
  process.env.ADMIN_SECRET = SECRET;
  process.env.ADMIN_BREAK_GLASS_ENABLED = "1";
});
afterEach(() => {
  process.env = { ...env };
});

describe("POST /api/admin/login (break glass)", () => {
  it("is disabled by default — the shared secret no longer logs people in", async () => {
    delete process.env.ADMIN_BREAK_GLASS_ENABLED;
    const res = await login(req({ email: "a@x.ro", password: SECRET }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("break_glass_disabled");
    expect(h.calls).toHaveLength(0);
  });

  it("rate-limits attempts", async () => {
    h.allowed = false;
    expect((await login(req({ email: "a@x.ro", password: SECRET }))).status).toBe(429);
  });

  it("wrong secret or non-admin email → same 401, audited as a failed attempt", async () => {
    h.adminRows = [{ id: "u-1", admin_role: "owner" }];
    const wrong = await login(req({ email: "a@x.ro", password: "nope" }));
    h.adminRows = [];
    const notAdmin = await login(req({ email: "b@x.ro", password: SECRET }));
    for (const res of [wrong, notAdmin]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("invalid_credentials");
    }
    expect(audit().map((r) => r.slice(1, 4))).toEqual([
      ["anonymous", null, "admin.break_glass_failed"],
      ["anonymous", null, "admin.break_glass_failed"],
    ]);
    expect(h.calls.some((c) => c.sql.includes("INSERT INTO admin_sessions"))).toBe(false);
  });

  it("secret + admin email → session bound to that admin (kind break_glass), audited", async () => {
    h.adminRows = [{ id: "u-1", admin_role: "ops" }];
    const res = await login(req({ email: "A@x.ro ", password: SECRET }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^admin_token=[0-9a-f]{64};/);
    const insert = h.calls.find((c) => c.sql.includes("INSERT INTO admin_sessions"));
    expect(insert?.params.slice(1, 3)).toEqual(["u-1", "break_glass"]);
    expect(h.calls.find((c) => c.sql.includes("lower(email)"))?.params).toEqual(["a@x.ro"]);
    expect(audit()[0].slice(0, 4)).toEqual(["u-1", "break_glass", "ops", "admin.break_glass_login"]);
  });
});

describe("POST /api/admin/logout", () => {
  it("revokes the current session, clears the cookie and audits the admin", async () => {
    h.sessionRows = [{ token: "h", kind: "otp", user_id: "u-2", email: "c@x.ro", username: "c", admin_role: "support" }];
    const res = await logout(
      new Request("http://localhost/api/admin/logout", { method: "POST", headers: { cookie: "admin_token=tok" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(h.calls.some((c) => c.sql.includes("UPDATE admin_sessions SET revoked_at"))).toBe(true);
    expect(audit()[0].slice(0, 4)).toEqual(["u-2", "admin_user", "support", "admin.logout"]);
  });

  it("without a cookie it only clears (nothing written)", async () => {
    const res = await logout(new Request("http://localhost/api/admin/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(0);
  });
});
