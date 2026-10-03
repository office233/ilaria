import { describe, it, expect, vi, beforeEach } from "vitest";

type Q = { sql: string; params: unknown[] };
let calls: Q[] = [];
let handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number } = () => ({ rows: [], rowCount: 0 });
const intentsCreate = vi.fn();
const refundsCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  }),
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }),
}));
vi.mock("@/lib/stripe/checkout", () => ({
  getStripe: () => ({ paymentIntents: { create: intentsCreate }, refunds: { create: refundsCreate } }),
}));

import { createMission, createFundingIntent, markMissionFunded, closeMission, closeExpiredMissions } from "@/lib/missions/funding";
import { missionPoolCents, escrowRemainingCents } from "@/lib/missions/config";

const input = { title: "Unboxing căști", brief: "Arată cum sună căștile în metrou, 30 secunde.", prizeCents: 10_000, maxWinners: 3, durationDays: 14 };

beforeEach(() => {
  calls = [];
  intentsCreate.mockReset();
  refundsCreate.mockReset();
  handler = () => ({ rows: [], rowCount: 0 });
});

describe("missions config", () => {
  it("pool = premiu × câștigători; 0 pentru valori invalide", () => {
    expect(missionPoolCents(10_000, 3)).toBe(30_000);
    expect(missionPoolCents(0, 3)).toBe(0);
    expect(missionPoolCents(100, 0)).toBe(0);
  });
  it("escrow rămas = finanțat − plătit − returnat, niciodată negativ", () => {
    expect(escrowRemainingCents({ funded_cents: "30000", paid_out_cents: "10000", refunded_cents: 0 })).toBe(20_000);
    expect(escrowRemainingCents({ funded_cents: 0, paid_out_cents: 0, refunded_cents: 5 })).toBe(0);
  });
});

describe("createMission", () => {
  it("seller → draft nefinanțat (0 bani în escrow)", async () => {
    handler = () => ({ rows: [{ id: "m1", slug: "unboxing-casti-abc" }], rowCount: 1 });
    await createMission(input, { kind: "seller", sellerId: "s1", userId: "u1" });
    const p = calls[0].params;
    expect(calls[0].sql).toContain("INSERT INTO creator_missions");
    expect(p[8]).toBe("draft");
    expect(p[9]).toBe("seller");
    expect(p[10]).toBe("unfunded");
    expect(p[11]).toBe(0);
  });
  it("platformă → activă și finanțată cu tot fondul", async () => {
    handler = () => ({ rows: [{ id: "m2", slug: "x" }], rowCount: 1 });
    await createMission(input, { kind: "platform", userId: null });
    const p = calls[0].params;
    expect(p[8]).toBe("active");
    expect(p[10]).toBe("funded");
    expect(p[11]).toBe(30_000);
  });
});

describe("createFundingIntent", () => {
  it("creează PaymentIntent RON pe fondul complet, idempotent pe misiune+sumă", async () => {
    handler = (sql) =>
      sql.startsWith("SELECT id, prize_amount_minor")
        ? { rows: [{ id: "m1", prize_amount_minor: 10_000, max_winners: 3, funding_status: "unfunded", status: "draft" }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    intentsCreate.mockResolvedValue({ id: "pi_1", client_secret: "sec" });
    const res = await createFundingIntent("m1", "s1");
    expect(res).toEqual({ ok: true, clientSecret: "sec", amountCents: 30_000 });
    const [params, opts] = intentsCreate.mock.calls[0];
    expect(params).toMatchObject({ amount: 30_000, currency: "ron", metadata: { kind: "mission_funding", mission_id: "m1" } });
    expect(opts).toEqual({ idempotencyKey: "mission_funding:m1:30000" });
    expect(calls.some((c) => c.sql.includes("SET funding_status = 'pending'"))).toBe(true);
  });
  it("refuză misiunile deja finanțate sau ale altui seller", async () => {
    handler = () => ({ rows: [{ id: "m1", prize_amount_minor: 1, max_winners: 1, funding_status: "funded", status: "draft" }], rowCount: 1 });
    expect(await createFundingIntent("m1", "s1")).toEqual({ ok: false, code: "already_funded" });
    handler = () => ({ rows: [], rowCount: 0 });
    expect(await createFundingIntent("m1", "other")).toEqual({ ok: false, code: "not_found" });
    expect(intentsCreate).not.toHaveBeenCalled();
  });
});

describe("markMissionFunded (webhook)", () => {
  const row = { id: "m1", prize_amount_minor: 10_000, max_winners: 3, status: "draft" };
  it("activează misiunea când suma acoperă fondul", async () => {
    handler = (sql) => (sql.startsWith("SELECT") ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 1 });
    const r = await markMissionFunded({ paymentIntentId: "pi_1", missionId: "m1", amountReceivedCents: 30_000, currency: "ron" });
    expect(r).toBe("funded");
    const upd = calls.find((c) => c.sql.includes("SET funding_status = 'funded'"));
    expect(upd?.params).toEqual(["m1", 30_000, "pi_1"]);
    expect(upd?.sql).toContain("status = 'active'");
  });
  it("sub-plată → nu se activează", async () => {
    handler = () => ({ rows: [row], rowCount: 1 });
    const r = await markMissionFunded({ paymentIntentId: "pi_1", missionId: "m1", amountReceivedCents: 29_999, currency: "ron" });
    expect(r).toBe("underpaid");
    expect(calls.some((c) => c.sql.includes("'funded'") && c.sql.startsWith("UPDATE"))).toBe(false);
  });
  it("retry Stripe pe o misiune deja finanțată → noop", async () => {
    handler = () => ({ rows: [], rowCount: 0 });
    expect(await markMissionFunded({ paymentIntentId: "pi_1", missionId: "m1", amountReceivedCents: 30_000, currency: "ron" })).toBe("noop");
  });
  it("plată sosită după închidere → refund integral", async () => {
    handler = (sql) => (sql.startsWith("SELECT") ? { rows: [{ ...row, status: "closed" }], rowCount: 1 } : { rows: [], rowCount: 1 });
    const r = await markMissionFunded({ paymentIntentId: "pi_1", missionId: "m1", amountReceivedCents: 30_000, currency: "ron" });
    expect(r).toBe("refunded_closed");
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1" }),
      { idempotencyKey: "mission_refund_closed:m1" },
    );
  });
});

describe("closeMission", () => {
  const base = {
    id: "m1", status: "active", funding_source: "seller", funding_payment_intent_id: "pi_1",
    funded_cents: "30000", paid_out_cents: "10000", refunded_cents: "0", unpaid_winners: 0,
  };
  it("returnează restul din escrow pe card și închide", async () => {
    handler = (sql) => (sql.startsWith("SELECT") ? { rows: [base], rowCount: 1 } : { rows: [], rowCount: 1 });
    const r = await closeMission("m1", { sellerId: "s1" });
    expect(r).toEqual({ ok: true, refundedCents: 20_000 });
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1", amount: 20_000 }),
      { idempotencyKey: "mission_refund:m1:20000" },
    );
    const upd = calls.find((c) => c.sql.includes("SET status = 'closed'"));
    expect(upd?.params).toEqual(["m1", 20_000]);
  });
  it("refuză cât timp există câștigători neplătiți", async () => {
    handler = () => ({ rows: [{ ...base, unpaid_winners: 1 }], rowCount: 1 });
    expect(await closeMission("m1", {})).toEqual({ ok: false, code: "unpaid_winners" });
    expect(refundsCreate).not.toHaveBeenCalled();
  });
  it("misiune de platformă: eliberează bugetul fără Stripe", async () => {
    handler = (sql) =>
      sql.startsWith("SELECT") ? { rows: [{ ...base, funding_source: "platform", funding_payment_intent_id: null }], rowCount: 1 } : { rows: [], rowCount: 1 };
    expect(await closeMission("m1", {})).toEqual({ ok: true, refundedCents: 20_000 });
    expect(refundsCreate).not.toHaveBeenCalled();
  });
});

describe("closeMission — lock + mașina de stări", () => {
  const base = {
    id: "m1", status: "active", funding_source: "seller", funding_payment_intent_id: "pi_1",
    funded_cents: "30000", paid_out_cents: "10000", refunded_cents: "0", unpaid_winners: 0,
  };
  it("blochează misiunea (FOR UPDATE) și închide ÎNAINTE de refund, în aceeași tranzacție", async () => {
    const order: string[] = [];
    handler = (sql) => {
      if (sql.startsWith("SELECT")) order.push("select");
      if (sql.startsWith("UPDATE")) order.push("update");
      return sql.startsWith("SELECT") ? { rows: [base], rowCount: 1 } : { rows: [], rowCount: 1 };
    };
    refundsCreate.mockImplementation(async () => { order.push("refund"); return {}; });
    await closeMission("m1", {});
    expect(calls[0].sql).toContain("FOR UPDATE OF m");
    expect(order).toEqual(["select", "update", "refund"]);
  });
  it("refund eșuat → excepția anulează tranzacția (misiunea nu rămâne închisă fără bani returnați)", async () => {
    handler = (sql) => (sql.startsWith("SELECT") ? { rows: [base], rowCount: 1 } : { rows: [], rowCount: 1 });
    refundsCreate.mockRejectedValue(new Error("stripe down"));
    await expect(closeMission("m1", {})).rejects.toThrow("stripe down");
  });
  it("misiune deja închisă/arhivată → already_closed, fără refund", async () => {
    for (const status of ["closed", "archived"]) {
      handler = () => ({ rows: [{ ...base, status }], rowCount: 1 });
      expect(await closeMission("m1", {})).toEqual({ ok: false, code: "already_closed" });
    }
    expect(refundsCreate).not.toHaveBeenCalled();
  });
});

describe("closeExpiredMissions (cron missions-expire)", () => {
  it("închide doar misiunile expirate fără câștigători neplătiți, cu grația configurată", async () => {
    const base = {
      id: "m9", status: "active", funding_source: "platform", funding_payment_intent_id: null,
      funded_cents: "5000", paid_out_cents: "0", refunded_cents: "0", unpaid_winners: 0,
    };
    handler = (sql) => {
      if (sql.includes("ends_at < now()")) return { rows: [{ id: "m9" }], rowCount: 1 };
      if (sql.startsWith("SELECT")) return { rows: [base], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    expect(await closeExpiredMissions({ graceDays: 7, limit: 50 })).toEqual({ closed: 1, failed: 0 });
    const pick = calls.find((c) => c.sql.includes("ends_at < now()"));
    expect(pick?.params).toEqual([7, 50]);
    expect(pick?.sql).toContain("s.status = 'winner'");
  });
  it("un refund eșuat e numărat, restul continuă", async () => {
    const base = {
      id: "m1", status: "active", funding_source: "seller", funding_payment_intent_id: "pi_1",
      funded_cents: "5000", paid_out_cents: "0", refunded_cents: "0", unpaid_winners: 0,
    };
    handler = (sql) => {
      if (sql.includes("ends_at < now()")) return { rows: [{ id: "m1" }, { id: "m2" }], rowCount: 2 };
      if (sql.startsWith("SELECT")) return { rows: [base], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    refundsCreate.mockRejectedValueOnce(new Error("stripe down")).mockResolvedValueOnce({});
    expect(await closeExpiredMissions({ graceDays: 0, limit: 10 })).toEqual({ closed: 1, failed: 1 });
  });
});
