import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/security/admin-auth", () => ({
  getAdminActorFromRequest: async () => ({ kind: "admin_user", userId: "admin-1", email: null, username: null, role: "moderator", sessionHash: "h" }),
}));

const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
const dbQueryMock = vi.fn(async (sql: string, params?: unknown[]) => {
  queryCalls.push({ sql, params });
  return { rows: [{ score: 12, strike_count: 2, blocked_count: 0, adult_count: 0, sensitive_count: 0, status: "active", suspended_until: null, suspension_reason: null }] };
});
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => dbQueryMock(sql, params),
}));

import { GET } from "@/app/api/admin/strikes/route";

beforeEach(() => {
  queryCalls.length = 0;
  dbQueryMock.mockClear();
});

describe("GET /api/admin/strikes?userId=", () => {
  it("joins user_risk_scores keyed on user_id — not a constant-true predicate that fans out to every row", async () => {
    const res = await GET(new Request("http://localhost/api/admin/strikes?userId=11111111-1111-1111-1111-111111111111"));
    expect(res.status).toBe(200);

    // Second dbQuery call is the per-user summary lookup; the fix keys the
    // LEFT JOIN on r.user_id = u.id — a plain `RIGHT JOIN ... ON u.id = $1`
    // (the pre-fix version) has no relationship between r and u, so it
    // cross-joins the single matched user row with every row of
    // user_risk_scores instead of returning just that user's row.
    const summaryQuery = queryCalls[1];
    expect(summaryQuery.sql).toMatch(/LEFT JOIN user_risk_scores r ON r\.user_id = u\.id/);
    expect(summaryQuery.sql).not.toMatch(/RIGHT JOIN users u ON u\.id = \$1/);
  });
});
