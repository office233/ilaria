import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery }));

import { getWalletSnapshot } from "@/lib/wallet/read-model";

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => dbQuery.mockReset());

describe("wallet read model", () => {
  it("returns normalized balance, totals and a stable bigint-id cursor", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ balance_cents: "7250", currency: "RON" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ credits: "10000", debits: "2750" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: "9", kind: "credit", amount_cents: "5000", balance_after_cents: "7250", ref_type: "mission_prize", ref_id: "m1", created_at: "2026-09-29T10:00:00Z" },
          { id: "8", kind: "debit", amount_cents: "1000", balance_after_cents: "2250", ref_type: "payout", ref_id: "p1", created_at: "2026-09-28T10:00:00Z" },
          { id: "7", kind: "credit", amount_cents: "3250", balance_after_cents: "3250", ref_type: "ride", ref_id: "r1", created_at: "2026-09-27T10:00:00Z" },
        ],
        rowCount: 3,
      });

    const wallet = await getWalletSnapshot(USER, { limit: 2 });
    expect(wallet).toMatchObject({
      balanceCents: 7250,
      currency: "RON",
      totalCreditsCents: 10000,
      totalDebitsCents: 2750,
      nextCursor: "8",
    });
    expect(wallet.activity).toHaveLength(2);
    expect(wallet.activity[0].amountCents).toBe(5000);
  });

  it("returns a zero wallet when the user has no balance row or ledger activity", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ credits: "0", debits: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const wallet = await getWalletSnapshot(USER);
    expect(wallet.balanceCents).toBe(0);
    expect(wallet.activity).toEqual([]);
    expect(wallet.nextCursor).toBeNull();
  });

  it("rejects malformed cursors before querying the ledger", async () => {
    await expect(getWalletSnapshot(USER, { cursor: "1 OR 1=1" })).rejects.toThrow("invalid_wallet_cursor");
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
