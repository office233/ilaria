import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let handler: (sql: string, params: unknown[]) => { rows: any[]; rowCount: number };

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(),
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }),
}));
vi.mock("@/lib/dm/repository", () => ({
  requireParticipant: vi.fn(async () => undefined),
}));

import { addGroupMembers, removeGroupMember, setGroupAdmin } from "@/lib/dm/groups";

const CONV = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  calls = [];
  handler = (sql) => {
    if (sql.includes("SELECT cp.is_admin") && sql.includes("c.kind = 'group'")) {
      return { rows: [{ is_admin: true }], rowCount: 1 };
    }
    if (sql.includes("SELECT user_id") && sql.includes("ANY($2::uuid[])")) {
      return { rows: [{ user_id: B }], rowCount: 1 };
    }
    if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: 2 }], rowCount: 1 };
    if (sql.includes("SELECT id FROM users")) return { rows: [{ id: C }], rowCount: 1 };
    if (sql.includes("FROM user_blocks")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO conversation_participants")) return { rows: [], rowCount: 1 };
    if (sql.includes("UPDATE conversation_participants")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
});

describe("Messenger group membership", () => {
  it("adds only new members when the request also contains existing members", async () => {
    expect(await addGroupMembers(CONV, A, [B, C, B])).toBe(1);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO conversation_participants"));
    expect(insert?.params).toEqual([CONV, [C]]);
  });

  it("prevents the last admin from leaving the group", async () => {
    handler = (sql) => {
      if (sql.includes("SELECT cp.is_admin") && sql.includes("FOR UPDATE")) {
        return { rows: [{ is_admin: true }], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    await expect(removeGroupMember(CONV, A, A)).rejects.toMatchObject({
      status: 409,
      code: "last_admin",
    });
  });

  it("allows an admin to promote an existing member", async () => {
    await expect(setGroupAdmin(CONV, A, B, true)).resolves.toBeUndefined();
    const update = calls.find((call) => call.sql.includes("UPDATE conversation_participants"));
    expect(update?.params).toEqual([CONV, B, true]);
  });
});
