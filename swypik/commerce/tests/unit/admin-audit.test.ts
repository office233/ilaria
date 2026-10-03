import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminActor } from "@/lib/security/admin-auth";
import { MACHINE, OWNER } from "./helpers/admin-actors";

const calls: { sql: string; params: unknown[] }[] = [];
let failInsert = false;
let requestActor: AdminActor | null = null;
let cookieActor: AdminActor | null = null;

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (failInsert) throw new Error("db down");
    calls.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock("@/lib/security/admin-auth", () => ({
  getAdminActorFromRequest: vi.fn(async () => requestActor),
  getAdminActor: vi.fn(async () => cookieActor),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { logAdminAction } from "@/lib/security/admin-audit";

describe("logAdminAction", () => {
  beforeEach(() => {
    calls.length = 0;
    failInsert = false;
    requestActor = null;
    cookieActor = null;
  });

  it("records the named admin behind the request, with role, target, details and ip", async () => {
    requestActor = OWNER;
    const req = new Request("https://swypik.com/api/admin/x", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    await logAdminAction({ action: "order.refund", targetType: "order", targetId: 42, details: { amount: 100 }, req });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([OWNER.userId, "admin_user", "owner", "order.refund", "order", "42", '{"amount":100}', "1.2.3.4"]);
  });

  it("uses an explicit actor without a lookup and marks machines", async () => {
    await logAdminAction({ action: "movies.ingest", actor: MACHINE });
    expect(calls[0].params.slice(0, 4)).toEqual([null, "machine", "machine", "movies.ingest"]);
  });

  it("falls back to the cookie session for server actions (no request)", async () => {
    cookieActor = OWNER;
    await logAdminAction({ action: "seller.approve" });
    expect(calls[0].params.slice(0, 2)).toEqual([OWNER.userId, "admin_user"]);
  });

  it("records explicit / anonymous callers by kind", async () => {
    await logAdminAction({ action: "admin.login_failed", actorKind: "anonymous" });
    await logAdminAction({ action: "cron.run" });
    expect(calls[0].params.slice(0, 3)).toEqual([null, "anonymous", null]);
    expect(calls[1].params.slice(0, 3)).toEqual([null, "anonymous", null]);
  });

  it("never throws when the insert fails", async () => {
    failInsert = true;
    await expect(logAdminAction({ action: "user.ban", targetId: "u-2" })).resolves.toBeUndefined();
  });
});
