import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { sql: string; params: unknown[] }[] = [];
let validatedRows: { referrer_user_id: string }[] = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("UPDATE referral_attributions")) return { rows: validatedRows, rowCount: validatedRows.length };
    if (sql.includes("FROM commerce_orders")) return { rows: [{ buyer_user_id: "buyer-1" }], rowCount: 1 };
    if (sql.includes("FROM rides")) return { rows: [{ rider_user_id: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { onOrderPaid, onRidePaid, onUserPaidTransaction } from "@/lib/referral/validation";

describe("referral validation (no rewards)", () => {
  beforeEach(() => {
    calls.length = 0;
    validatedRows = [];
  });

  it("validates the buyer's attribution on the first paid shop order", async () => {
    validatedRows = [{ referrer_user_id: "ref-1" }];
    await onOrderPaid("order-1", "pi_1");
    const upd = calls.find((c) => c.sql.includes("UPDATE referral_attributions"));
    expect(upd?.params).toEqual(["buyer-1", "first_paid:shop_order"]);
    expect(calls.some((c) => /swyp/i.test(c.sql))).toBe(false);
  });

  it("does nothing for guest payments", async () => {
    await onRidePaid("ride-1", "cash_ride_ride-1");
    expect(calls.some((c) => c.sql.includes("UPDATE referral_attributions"))).toBe(false);
  });

  it("never throws when the database fails", async () => {
    const { dbQuery } = await import("@/lib/db");
    vi.mocked(dbQuery).mockRejectedValueOnce(new Error("db down"));
    await expect(onUserPaidTransaction("u-1", "pi_2", "other")).resolves.toBeUndefined();
  });
});
