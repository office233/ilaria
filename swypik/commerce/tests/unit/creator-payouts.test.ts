import { describe, it, expect, vi, beforeEach } from "vitest";

type Q = { sql: string; params: unknown[] };
let calls: Q[] = [];
let connectAccount: { id: string | null; ready: boolean } = { id: null, ready: false };
let insertOk = true;
let pendingRow = true;
let connectFlag = false;
let debitError: Error | null = null;
let pendingIban: string | null = "RO49AAAA1B31007593840000";
let wallet = { balance: "100000", held: "0" };
const credits: Array<Record<string, unknown>> = [];
const transfers = vi.fn();

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("stripe_connect_account_id AS id")) return { rows: [connectAccount], rowCount: 1 };
    if (sql.includes("AS held")) return { rows: [wallet], rowCount: 1 };
    if (sql.startsWith("INSERT INTO payout_requests")) return { rows: insertOk ? [{ id: "pr1" }] : [], rowCount: insertOk ? 1 : 0 };
    if (sql.includes("SET status = 'processing'")) {
      return { rows: pendingRow ? [{ id: "pr1", user_id: "c1", amount_cents: "7500", iban: pendingIban }] : [], rowCount: pendingRow ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: (f: string) => f === "stripeConnect" && connectFlag }));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => ({ transfers: { create: transfers } }) }));
vi.mock("@/lib/notifications/localized", () => ({ notifyLocalized: vi.fn(async () => undefined) }));
vi.mock("@/lib/wallet/ledger", async () => {
  class InsufficientFundsError extends Error {
    constructor(public readonly balanceCents: number, public readonly requestedCents: number) {
      super("insufficient");
    }
  }
  return {
    InsufficientFundsError,
    debitUser: vi.fn(async () => {
      if (debitError) throw debitError;
      return { entry: {}, alreadyApplied: false };
    }),
    creditUser: vi.fn(async (a: Record<string, unknown>) => {
      credits.push(a);
      return { entry: {}, alreadyApplied: false };
    }),
  };
});

import { requestCreatorPayout, resolveCreatorPayout, getPayoutReadiness, getWithdrawable } from "@/lib/creator/payouts";
import { InsufficientFundsError } from "@/lib/wallet/ledger";

const IBAN = "RO49AAAA1B31007593840000";

beforeEach(() => {
  calls = [];
  credits.length = 0;
  transfers.mockReset();
  connectAccount = { id: null, ready: false };
  insertOk = true;
  pendingRow = true;
  connectFlag = false;
  debitError = null;
  pendingIban = "RO49AAAA1B31007593840000";
  wallet = { balance: "100000", held: "0" };
  delete process.env.MISSION_PRIZE_HOLD_DAYS;
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  delete process.env.CREATOR_PAYOUT_MIN_CENTS;
  delete process.env.PAYOUT_MIN_CENTS;
});

describe("readiness — stare onestă fără Stripe Connect", () => {
  it("flag oprit → transfer bancar (IBAN), chiar dacă există cont Connect", async () => {
    connectAccount = { id: "acct_1", ready: true };
    expect(await getPayoutReadiness("c1")).toMatchObject({ method: "bank", connectAvailable: false, connectAccountReady: false, minCents: 5000 });
  });
  it("flag + cheie + cont activ → stripe", async () => {
    connectFlag = true;
    connectAccount = { id: "acct_1", ready: true };
    expect(await getPayoutReadiness("c1")).toMatchObject({ method: "stripe", connectAvailable: true, connectAccountReady: true });
  });
});

describe("requestCreatorPayout", () => {
  it("sub prag → below_minimum; fără IBAN la metoda bancară → iban_required", async () => {
    expect(await requestCreatorPayout({ userId: "c1", amountCents: 4999, iban: IBAN })).toEqual({ ok: false, code: "below_minimum" });
    expect(await requestCreatorPayout({ userId: "c1", amountCents: 5000, iban: null })).toEqual({ ok: false, code: "iban_required" });
  });
  it("creează cererea 'creator' și debitează portofelul", async () => {
    expect(await requestCreatorPayout({ userId: "c1", amountCents: 7500, iban: IBAN })).toEqual({ ok: true, id: "pr1", method: "bank" });
    const ins = calls.find((c) => c.sql.startsWith("INSERT INTO payout_requests"));
    expect(ins?.sql).toContain("'creator'");
    expect(ins?.sql).toContain("status IN ('pending', 'processing')");
    // Garda DB (index unic parțial, migrarea 20260928_0062): perdantul unei curse primește 0 rânduri.
    expect(ins?.sql).toContain("ON CONFLICT DO NOTHING");
  });
  it("o singură cerere deschisă", async () => {
    insertOk = false;
    expect(await requestCreatorPayout({ userId: "c1", amountCents: 7500, iban: IBAN })).toEqual({ ok: false, code: "open_request_exists" });
  });
  it("sold insuficient → cererea e respinsă automat", async () => {
    debitError = new InsufficientFundsError(1000, 7500);
    expect(await requestCreatorPayout({ userId: "c1", amountCents: 7500, iban: IBAN })).toEqual({ ok: false, code: "insufficient_funds", balanceCents: 1000 });
    expect(calls.some((c) => c.sql.includes("admin_note = 'insufficient_funds'"))).toBe(true);
  });
});

describe("resolveCreatorPayout (admin)", () => {
  it("rejected → suma revine în portofel", async () => {
    expect(await resolveCreatorPayout({ id: "pr1", action: "rejected", note: null })).toEqual({ ok: true, status: "rejected", via: null });
    expect(credits[0]).toMatchObject({ userId: "c1", amountCents: 7500, refType: "payout_refund", refId: "pr1" });
  });
  it("paid fără Connect → confirmare transfer bancar, fără Stripe", async () => {
    expect(await resolveCreatorPayout({ id: "pr1", action: "paid", note: "OP 123" })).toEqual({ ok: true, status: "paid", via: "bank" });
    expect(transfers).not.toHaveBeenCalled();
  });
  it("paid cu Connect → transfer Stripe idempotent", async () => {
    connectFlag = true;
    connectAccount = { id: "acct_1", ready: true };
    transfers.mockResolvedValue({ id: "tr_1" });
    expect(await resolveCreatorPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: true, status: "paid", via: "stripe" });
    expect(transfers.mock.calls[0][0]).toMatchObject({ amount: 7500, currency: "ron", destination: "acct_1" });
    expect(transfers.mock.calls[0][1]).toEqual({ idempotencyKey: "creator_payout:pr1" });
  });
  it("transfer eșuat → cererea revine 'pending' cu motiv; banii rămân blocați, nu se pierd", async () => {
    connectFlag = true;
    connectAccount = { id: "acct_1", ready: true };
    transfers.mockRejectedValue(new Error("insufficient platform balance"));
    expect(await resolveCreatorPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: false, code: "transfer_failed" });
    expect(calls.some((c) => c.sql.includes("SET status = 'pending', failure_reason"))).toBe(true);
  });
  it("cerere deja rezolvată → not_pending", async () => {
    pendingRow = false;
    expect(await resolveCreatorPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: false, code: "not_pending" });
  });
});

describe("premii de misiune reținute (anti-fraudă)", () => {
  it("suma care atinge premiile recente → funds_on_hold, fără cerere și fără debit", async () => {
    wallet = { balance: "20000", held: "15000" };
    const r = await requestCreatorPayout({ userId: "c1", amountCents: 10_000, iban: IBAN });
    expect(r).toEqual({ ok: false, code: "funds_on_hold", balanceCents: 20_000, withdrawableCents: 5_000 });
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO payout_requests"))).toBe(false);
  });
  it("restul (neretinut) se poate retrage", async () => {
    wallet = { balance: "20000", held: "15000" };
    expect(await requestCreatorPayout({ userId: "c1", amountCents: 5_000, iban: IBAN })).toMatchObject({ ok: true });
  });
  it("fereastra de reținere vine din MISSION_PRIZE_HOLD_DAYS (default 14) și se aplică doar pe mission_prize", async () => {
    process.env.MISSION_PRIZE_HOLD_DAYS = "30";
    const funds = await getWithdrawable("c1");
    expect(funds.holdDays).toBe(30);
    const q = calls.find((c) => c.sql.includes("AS held"));
    expect(q?.sql).toContain("ref_type = 'mission_prize'");
    expect(q?.params).toEqual(["c1", 30]);
  });
});

describe("resolveCreatorPayout — IBAN obligatoriu la transfer bancar", () => {
  it("paid prin bancă fără IBAN → iban_missing, cererea revine pending", async () => {
    pendingIban = null;
    expect(await resolveCreatorPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: false, code: "iban_missing" });
    expect(calls.some((c) => c.sql.includes("failure_reason = 'iban_missing'"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("SET status = 'paid'"))).toBe(false);
  });
});
