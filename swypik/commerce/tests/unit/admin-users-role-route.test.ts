/**
 * /api/admin/users/[id]/{suspend,unsuspend,role,admin-role,fraud-block}:
 * autentificare + RBAC, reguli de business și jurnalul de audit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminActor } from "@/lib/security/admin-auth";
import {
  auditInserts,
  FINANCE,
  idParams,
  jsonReq,
  MACHINE,
  MODERATOR,
  OWNER,
  SUPPORT,
  TARGET_USER,
  type SqlCall,
} from "./helpers/admin-actors";

const h = vi.hoisted(() => ({
  actor: null as AdminActor | null,
  db: [] as { sql: string; params: unknown[] }[],
  tx: [] as { sql: string; params: unknown[] }[],
  txResponses: [] as { rows: unknown[]; rowCount?: number }[],
  notify: [] as unknown[][],
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.db.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }),
  withTransaction: async (fn: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      h.tx.push({ sql, params });
      return h.txResponses.shift() ?? { rows: [], rowCount: 1 };
    }),
}));
vi.mock("@/lib/security/admin-auth", () => ({
  getAdminActorFromRequest: async () => h.actor,
  getAdminActor: async () => h.actor,
  revokeAdminSessionsForUser: async (id: string, q: (s: string, p: unknown[]) => Promise<unknown>) =>
    q("UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1", [id]),
}));
vi.mock("@/lib/notifications/localized", () => ({
  notifyLocalized: async (...a: unknown[]) => void h.notify.push(a),
}));
vi.mock("@/lib/risk/user-block", () => ({ setUserFraudBlock: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as suspend } from "@/app/api/admin/users/[id]/suspend/route";
import { POST as unsuspend } from "@/app/api/admin/users/[id]/unsuspend/route";
import { POST as role } from "@/app/api/admin/users/[id]/role/route";
import { POST as adminRole } from "@/app/api/admin/users/[id]/admin-role/route";
import { POST as fraudBlock } from "@/app/api/admin/users/[id]/fraud-block/route";

const url = (action: string) => `/api/admin/users/${TARGET_USER}/${action}`;
const audit = () => auditInserts(h.db as SqlCall[]);
const txSql = () => h.tx.map((c) => c.sql).join("\n");

beforeEach(() => {
  h.actor = OWNER;
  h.db = [];
  h.tx = [];
  h.txResponses = [];
  h.notify = [];
});

describe("auth on every users mutation", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["suspend", () => suspend(jsonReq(url("suspend"), { days: 7, reason: "spam" }), idParams(TARGET_USER))],
    ["unsuspend", () => unsuspend(jsonReq(url("unsuspend")), idParams(TARGET_USER))],
    ["role", () => role(jsonReq(url("role"), { role: "creator" }), idParams(TARGET_USER))],
    ["admin-role", () => adminRole(jsonReq(url("admin-role"), { adminRole: "ops" }), idParams(TARGET_USER))],
    ["fraud-block", () => fraudBlock(jsonReq(url("fraud-block"), { action: "block", reason: "x" }), idParams(TARGET_USER))],
  ];
  it.each(cases)("%s → 401 without an admin session and writes nothing", async (_n, call) => {
    h.actor = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(h.tx).toHaveLength(0);
    expect(audit()).toHaveLength(0);
  });

  it("finance cannot suspend (users.manage) and support cannot change admin roles", async () => {
    h.actor = FINANCE;
    expect((await suspend(jsonReq(url("suspend"), { days: 7, reason: "x" }), idParams(TARGET_USER))).status).toBe(403);
    h.actor = SUPPORT;
    expect((await adminRole(jsonReq(url("admin-role"), { adminRole: "ops" }), idParams(TARGET_USER))).status).toBe(403);
    expect(audit()).toHaveLength(0);
  });

  it("rejects a malformed id with 400", async () => {
    const res = await suspend(jsonReq("/api/admin/users/x/suspend", { days: 1, reason: "r" }), idParams("not-a-uuid"));
    expect(res.status).toBe(400);
  });
});

describe("suspend / unsuspend", () => {
  it("suspends, revokes sessions, notifies and audits with the named actor", async () => {
    h.actor = MODERATOR;
    h.txResponses = [{ rows: [{ role: "shopper" }] }];
    const res = await suspend(jsonReq(url("suspend"), { days: 7, reason: "spam" }), idParams(TARGET_USER));
    expect(res.status).toBe(200);
    expect(txSql()).toContain("suspended_until");
    expect(txSql()).toContain("UPDATE user_sessions SET revoked_at");
    expect(txSql()).toContain("DELETE FROM seller_sessions");
    expect(audit()).toHaveLength(1);
    expect(audit()[0].slice(0, 6)).toEqual([MODERATOR.userId, "admin_user", "moderator", "user.suspend", "user", TARGET_USER]);
    expect(audit()[0][7]).toBe("10.0.0.1");
    expect(h.notify[0]?.[1]).toBe("accountSuspended");
  });

  it("refuses to suspend an admin and requires a reason", async () => {
    h.txResponses = [{ rows: [{ role: "admin" }] }];
    const res = await suspend(jsonReq(url("suspend"), { days: 7, reason: "x" }), idParams(TARGET_USER));
    expect((await res.json()).error).toBe("cannot_suspend_admin");
    const noReason = await suspend(jsonReq(url("suspend"), { days: 7, reason: " " }), idParams(TARGET_USER));
    expect((await noReason.json()).error).toBe("reason_required");
    expect(audit()).toHaveLength(0);
  });

  it("unsuspend returns 404 for an unknown user and audits on success", async () => {
    h.txResponses = [{ rows: [], rowCount: 0 }];
    expect((await unsuspend(jsonReq(url("unsuspend")), idParams(TARGET_USER))).status).toBe(404);
    expect(audit()).toHaveLength(0);
    const ok = await unsuspend(jsonReq(url("unsuspend")), idParams(TARGET_USER));
    expect(ok.status).toBe(200);
    expect(audit()[0][3]).toBe("user.unsuspend");
  });
});

describe("account role", () => {
  it("a moderator can switch shopper → creator; sessions are revoked and audited", async () => {
    h.actor = MODERATOR;
    h.txResponses = [{ rows: [{ role: "shopper" }] }];
    const res = await role(jsonReq(url("role"), { role: "creator" }), idParams(TARGET_USER));
    expect(res.status).toBe(200);
    expect(txSql()).toContain("UPDATE admin_sessions");
    expect(audit()[0][3]).toBe("user.role_change");
  });

  it("only an owner can grant admin — not a moderator, not a machine secret", async () => {
    for (const a of [MODERATOR, MACHINE]) {
      h.actor = a;
      h.txResponses = [{ rows: [{ role: "shopper" }] }];
      const res = await role(jsonReq(url("role"), { role: "admin", adminRole: "owner" }), idParams(TARGET_USER));
      expect(res.status).toBe(403);
    }
    expect(audit()).toHaveLength(0);
  });

  it("owner grants admin with an admin role (default support)", async () => {
    h.txResponses = [{ rows: [{ role: "creator" }] }];
    const res = await role(jsonReq(url("role"), { role: "admin" }), idParams(TARGET_USER));
    expect(await res.json()).toMatchObject({ ok: true, role: "admin", adminRole: "support" });
    const update = h.tx.find((c) => c.sql.includes("UPDATE users SET role"));
    expect(update?.params).toEqual([TARGET_USER, "admin", "support"]);
  });

  it("blocks self-demotion and the last-owner lockout", async () => {
    h.actor = { ...OWNER, userId: TARGET_USER };
    h.txResponses = [{ rows: [{ role: "admin" }] }];
    expect((await (await role(jsonReq(url("role"), { role: "shopper" }), idParams(TARGET_USER))).json()).error).toBe(
      "cannot_demote_self",
    );
    h.actor = OWNER;
    h.txResponses = [{ rows: [{ role: "admin" }] }, { rows: [{ c: 0 }] }];
    expect((await (await role(jsonReq(url("role"), { role: "shopper" }), idParams(TARGET_USER))).json()).error).toBe(
      "last_admin_lockout",
    );
  });

  it("rejects the legacy 'user' role (not allowed by users_role_check)", async () => {
    const res = await role(jsonReq(url("role"), { role: "user" }), idParams(TARGET_USER));
    expect((await res.json()).error).toBe("invalid_role");
  });
});

describe("admin role (RBAC)", () => {
  it("owner changes an admin's role and it is audited", async () => {
    h.txResponses = [{ rows: [{ role: "admin", admin_role: "support" }] }];
    const res = await adminRole(jsonReq(url("admin-role"), { adminRole: "finance" }), idParams(TARGET_USER));
    expect(res.status).toBe(200);
    expect(audit()[0][3]).toBe("user.admin_role_change");
  });

  it("refuses non-admin targets, own role and removing the last owner", async () => {
    h.txResponses = [{ rows: [{ role: "shopper", admin_role: null }] }];
    expect((await (await adminRole(jsonReq(url("admin-role"), { adminRole: "ops" }), idParams(TARGET_USER))).json()).error).toBe(
      "not_an_admin",
    );
    h.txResponses = [{ rows: [{ role: "admin", admin_role: "owner" }] }, { rows: [{ c: 0 }] }];
    expect((await (await adminRole(jsonReq(url("admin-role"), { adminRole: "ops" }), idParams(TARGET_USER))).json()).error).toBe(
      "last_owner_lockout",
    );
    h.actor = { ...OWNER, userId: TARGET_USER };
    expect((await adminRole(jsonReq(url("admin-role"), { adminRole: "ops" }), idParams(TARGET_USER))).status).toBe(400);
    expect(audit()).toHaveLength(0);
  });
});

describe("fraud block", () => {
  it("audits the block with the actor", async () => {
    h.actor = SUPPORT;
    h.db = [];
    const { dbQuery } = await import("@/lib/db");
    vi.mocked(dbQuery).mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      h.db.push({ sql, params });
      return { rows: [{ id: TARGET_USER }], rowCount: 1 } as never;
    });
    const res = await fraudBlock(jsonReq(url("fraud-block"), { action: "block", reason: "chargebacks" }), idParams(TARGET_USER));
    expect(res.status).toBe(200);
    expect(audit()[0].slice(1, 4)).toEqual(["admin_user", "support", "user.fraud_block"]);
  });
});
