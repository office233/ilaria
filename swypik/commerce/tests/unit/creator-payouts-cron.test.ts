import { describe, it, expect, vi, beforeEach } from "vitest";

type Q = { sql: string; params: unknown[] };
let calls: Q[] = [];
let candidates: Array<Record<string, unknown>> = [];
let claimWins = true;
let connectOn = false;
const credits: Array<Record<string, unknown>> = [];
const debits: Array<Record<string, unknown>> = [];
const transfers = vi.fn();

function q(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (sql.includes("FROM commerce_order_items coi") && sql.includes("self_attributed")) return { rows: candidates, rowCount: candidates.length };
  if (sql.includes("SET payout_status = 'paid'")) return { rows: claimWins ? [{ id: params[0] }] : [], rowCount: claimWins ? 1 : 0 };
  if (sql.includes("metadata ? 'creator_commission_cents'")) {
    return { rows: [{ id: "item-9", creator_id: "c1", cents: "250" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
}

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => q(sql, params)),
  withTransaction: async (fn: (qq: unknown) => Promise<unknown>) => fn(async (sql: string, params: unknown[] = []) => q(sql, params)),
}));
vi.mock("@/lib/wallet/ledger", () => ({
  creditUserTx: vi.fn(async (_q: unknown, a: Record<string, unknown>) => {
    credits.push(a);
    return { entry: {}, alreadyApplied: false };
  }),
  debitUserTx: vi.fn(async (_q: unknown, a: Record<string, unknown>) => {
    debits.push(a);
    return { entry: {}, alreadyApplied: false };
  }),
}));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: (f: string) => (f === "stripeConnect" ? connectOn : false) }));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => ({ transfers: { create: transfers } }) }));
vi.mock("@/lib/cron/runCron", () => ({
  runCron: async (_n: string, fn: () => Promise<unknown>) => fn(),
  cronSkippedResponse: () => new Response(null, { status: 204 }),
}));

import { accrueCreatorCommissions, creatorCommissionCents, reverseCreatorCommissionsForItems } from "@/lib/creator/commission";
import { GET as cron } from "@/app/api/cron/process-payouts/route";

beforeEach(() => {
  calls = [];
  credits.length = 0;
  debits.length = 0;
  transfers.mockReset();
  claimWins = true;
  connectOn = false;
  candidates = [{ item_id: "item-1", order_id: "o1", creator_id: "c1", commissionable_cents: 10_000, self_attributed: false }];
  process.env.CRON_SECRET = "s3cret-cron-value";
});

describe("comision creator — o singură rată, în ledger", () => {
  it("5% implicit, 0 pentru sume invalide", () => {
    expect(creatorCommissionCents(10_000)).toBe(500);
    expect(creatorCommissionCents(-5)).toBe(0);
    expect(creatorCommissionCents(10_000, 1000)).toBe(1000);
  });

  it("maturează itemul: claim atomic + credit în portofel cu rata snapshot", async () => {
    const r = await accrueCreatorCommissions(14);
    expect(r).toEqual({ accrued: 1, blocked: 0, skipped: 0 });
    const claim = calls.find((c) => c.sql.includes("SET payout_status = 'paid'"));
    expect(claim?.params.slice(0, 3)).toEqual(["item-1", 500, 500]);
    expect(credits[0]).toMatchObject({ userId: "c1", amountCents: 500, refType: "creator_commission", refId: "item-1" });
    // candidații NU mai depind de tabela goală creator_connect_accounts
    expect(calls[0].sql).not.toContain("creator_connect_accounts");
  });

  it("claim pierdut (alt worker) → fără credit dublu", async () => {
    claimWins = false;
    expect(await accrueCreatorCommissions(14)).toEqual({ accrued: 0, blocked: 0, skipped: 1 });
    expect(credits).toHaveLength(0);
  });

  it("auto-atribuire (sellerul e și creatorul) → blocat, fără comision", async () => {
    candidates = [{ ...candidates[0], self_attributed: true }];
    expect(await accrueCreatorCommissions(14)).toEqual({ accrued: 0, blocked: 1, skipped: 0 });
    expect(calls.some((c) => c.sql.includes("SET payout_status = 'restricted'"))).toBe(true);
    expect(credits).toHaveLength(0);
  });

  it("refund după maturare → comisionul se retrage din portofel (poate intra pe minus)", async () => {
    expect(await reverseCreatorCommissionsForItems(["item-9"], "seller_refund")).toBe(1);
    expect(debits[0]).toMatchObject({ userId: "c1", amountCents: 250, refType: "creator_commission_reversal", refId: "item-9", allowNegative: true });
  });
});

describe("cron process-payouts", () => {
  const req = (secret?: string) =>
    new Request("http://x/api/cron/process-payouts", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });

  it("fără secret → 401", async () => {
    expect((await cron(req())).status).toBe(401);
  });

  it("fără Stripe Connect: sellerii sunt săriți, comisioanele creatorilor tot se maturează", async () => {
    const res = await cron(req("s3cret-cron-value"));
    const json = await res.json();
    expect(json).toMatchObject({ success: true, sellerPayouts: "stripe_connect_disabled", creatorCommissionsAccrued: 1 });
    expect(transfers).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("seller_payout_cents"))).toBe(false);
  });

  it("cu Stripe Connect: rulează și bucla de selleri", async () => {
    connectOn = true;
    const json = await (await cron(req("s3cret-cron-value"))).json();
    expect(json.sellerPayouts).toBe(0);
    expect(calls.some((c) => c.sql.includes("seller_payout_cents"))).toBe(true);
  });
});
