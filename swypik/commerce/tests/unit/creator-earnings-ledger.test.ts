import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("GROUP BY ref_type, kind") && sql.includes("date_trunc")) {
      return { rows: [{ ref_type: "mission_prize", kind: "credit", cents: "5000" }], rowCount: 1 };
    }
    if (sql.includes("GROUP BY ref_type, kind")) {
      return {
        rows: [
          { ref_type: "creator_commission", kind: "credit", cents: "1200" },
          { ref_type: "creator_commission_reversal", kind: "debit", cents: "200" },
          { ref_type: "mission_prize", kind: "credit", cents: "5000" },
          { ref_type: "movie_creator_share", kind: "credit", cents: "700" },
          { ref_type: "payout", kind: "debit", cents: "3000" },
          { ref_type: "payout_refund", kind: "credit", cents: "1000" },
        ],
        rowCount: 6,
      };
    }
    if (sql.includes("FROM wallet_balances")) return { rows: [{ balance_cents: "4700" }], rowCount: 1 };
    if (sql.includes("FROM commerce_order_items")) return { rows: [{ base: "10000" }], rowCount: 1 };
    if (sql.includes("FROM payout_requests")) return { rows: [{ cents: "2000" }], rowCount: 1 };
    if (sql.includes("ORDER BY created_at DESC")) {
      return { rows: [{ id: "9", kind: "credit", amount_cents: "5000", ref_type: "mission_prize", created_at: "2026-09-25" }], rowCount: 1 };
    }
    throw new Error("unexpected " + sql.slice(0, 60));
  }),
}));

import { summarizeLedger, getCreatorEarnings } from "@/lib/creator/earnings";

describe("summarizeLedger — sursa unică: portofelul RON", () => {
  it("adună pe surse, scade reversările și separă retragerile", () => {
    const s = summarizeLedger([
      { ref_type: "creator_commission", kind: "credit", cents: 1200 },
      { ref_type: "creator_commission_reversal", kind: "debit", cents: 200 },
      { ref_type: "mission_prize", kind: "credit", cents: "5000" },
      { ref_type: "music_artist_share", kind: "credit", cents: 300 },
      { ref_type: "music_artist_share_reversal", kind: "debit", cents: 100 },
      { ref_type: "creator_fund_payout", kind: "credit", cents: 50 },
      { ref_type: "payout", kind: "debit", cents: 3000 },
      { ref_type: "payout_refund", kind: "credit", cents: 1000 },
      { ref_type: "ride", kind: "credit", cents: 999_999 },
    ]);
    expect(s.bySource).toEqual({ commissions: 1000, missions: 5000, movies: 0, music: 200, fund: 50 });
    expect(s.totalEarnedCents).toBe(6250);
    expect(s.withdrawnCents).toBe(2000);
  });
  it("fără intrări → zero peste tot", () => {
    expect(summarizeLedger([])).toEqual({ bySource: { commissions: 0, missions: 0, movies: 0, music: 0, fund: 0 }, totalEarnedCents: 0, withdrawnCents: 0 });
  });
});

describe("getCreatorEarnings", () => {
  it("combină ledger, sold, estimarea comisioanelor în fereastra de retur și retragerile în curs", async () => {
    const e = await getCreatorEarnings("u1");
    expect(e.totalEarnedCents).toBe(6700);
    expect(e.withdrawnCents).toBe(2000);
    expect(e.balanceCents).toBe(4700);
    expect(e.thisMonthEarnedCents).toBe(5000);
    expect(e.pendingCommissionCents).toBe(500); // 5% din 100 RON (CREATOR_COMMISSION_BPS implicit)
    expect(e.pendingPayoutCents).toBe(2000);
    expect(e.recent[0]).toEqual({ id: "9", kind: "credit", amountCents: 5000, refType: "mission_prize", source: "missions", createdAt: "2026-09-25" });
  });
});
