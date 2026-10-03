import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let seller: { account_id: string | null; ready: boolean; iban: string | null } = { account_id: null, ready: false, iban: null };
let eligible: Array<{ id: string; amt: number }> = [];
let insertOk = true;
let pending = true;
let requestedSum = 0;
let connectFlag = false;
const transfers = vi.fn();

function respond(sql: string, params: unknown[]) {
  calls.push({ sql, params });
  if (sql.includes("AS account_id") && sql.includes("FROM sellers")) return { rows: [seller], rowCount: 1 };
  if (sql.includes("FOR UPDATE OF coi")) return { rows: eligible, rowCount: eligible.length };
  if (sql.includes("INSERT INTO payout_requests")) return { rows: insertOk ? [{ id: "pr1" }] : [], rowCount: insertOk ? 1 : 0 };
  if (sql.includes("SET status = 'processing'")) {
    return { rows: pending ? [{ id: "pr1", seller_id: "s1" }] : [], rowCount: pending ? 1 : 0 };
  }
  if (sql.includes("AS amount") && sql.includes("seller_payout_request_id")) return { rows: [{ amount: requestedSum }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}

vi.mock("@/lib/db", () => {
  const q = vi.fn(async (sql: string, params: unknown[] = []) => respond(sql, params));
  return { dbQuery: q, withTransaction: async <T,>(fn: (tx: typeof q) => Promise<T>) => fn(q) };
});
vi.mock("@/lib/feature-flags", () => ({ isEnabled: (f: string) => f === "stripeConnect" && connectFlag }));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => ({ transfers: { create: transfers } }) }));
vi.mock("@/lib/notifications/localized", () => ({ notifyLocalized: vi.fn(async () => undefined) }));
vi.mock("@/lib/wallet/ledger", () => ({ creditUser: vi.fn(), debitUser: vi.fn(), InsufficientFundsError: class extends Error {} }));

import { requestSellerPayout, resolveSellerPayout, getSellerPayoutSetup } from "@/lib/seller/payouts";

const IBAN = "RO49AAAA1B31007593840000";

beforeEach(() => {
  calls = [];
  seller = { account_id: null, ready: false, iban: null };
  eligible = [];
  insertOk = true;
  pending = true;
  requestedSum = 0;
  connectFlag = false;
  transfers.mockReset();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  delete process.env.SELLER_PAYOUT_MIN_CENTS;
  delete process.env.PAYOUT_MIN_CENTS;
});

describe("getSellerPayoutSetup", () => {
  it("fără flag Connect → transfer bancar, chiar cu cont Stripe activ", async () => {
    seller = { account_id: "acct_1", ready: true, iban: null };
    expect(await getSellerPayoutSetup("s1")).toMatchObject({ method: "bank", connectAvailable: false, minCents: 5000 });
  });
  it("flag + cheie + cont activ → stripe", async () => {
    connectFlag = true;
    seller = { account_id: "acct_1", ready: true, iban: null };
    expect(await getSellerPayoutSetup("s1")).toMatchObject({ method: "stripe", connectReady: true });
  });
});

describe("requestSellerPayout", () => {
  it("fără IBAN (salvat sau trimis) la metoda bancară → iban_required, nimic scris", async () => {
    expect(await requestSellerPayout({ sellerId: "s1", iban: null })).toEqual({ ok: false, code: "iban_required" });
    expect(calls.some((c) => c.sql.includes("INSERT INTO payout_requests"))).toBe(false);
  });

  it("sold sub prag → below_minimum (cu soldul disponibil)", async () => {
    eligible = [{ id: "i1", amt: 3000 }];
    expect(await requestSellerPayout({ sellerId: "s1", iban: IBAN })).toEqual({ ok: false, code: "below_minimum", availableCents: 3000 });
  });

  it("cerere deschisă existentă → open_request_exists, item-urile rămân neatinse", async () => {
    eligible = [{ id: "i1", amt: 6000 }];
    insertOk = false;
    expect(await requestSellerPayout({ sellerId: "s1", iban: IBAN })).toEqual({ ok: false, code: "open_request_exists" });
    expect(calls.some((c) => c.sql.includes("'seller_payout_status', 'requested'"))).toBe(false);
  });

  it("succes: suma = tot soldul eligibil, kind='seller', user_id NULL, item-urile rezervate, IBAN salvat", async () => {
    eligible = [
      { id: "i1", amt: 4000 },
      { id: "i2", amt: 2500 },
    ];
    const res = await requestSellerPayout({ sellerId: "s1", iban: IBAN });
    expect(res).toEqual({ ok: true, id: "pr1", amountCents: 6500, method: "bank" });
    const ins = calls.find((c) => c.sql.includes("INSERT INTO payout_requests"));
    expect(ins?.sql).toContain("SELECT $1, NULL, 'seller'");
    expect(ins?.params).toEqual(["s1", 6500, "RON", IBAN, "method:bank"]);
    const mark = calls.find((c) => c.sql.includes("'seller_payout_status', 'requested'"));
    expect(mark?.params).toEqual([["i1", "i2"], "pr1"]);
    expect(calls.some((c) => c.sql.includes("UPDATE sellers SET business_details"))).toBe(true);
  });

  it("IBAN-ul salvat în profil e folosit când nu se trimite altul", async () => {
    seller = { account_id: null, ready: false, iban: IBAN };
    eligible = [{ id: "i1", amt: 9000 }];
    const res = await requestSellerPayout({ sellerId: "s1", iban: null });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.sql.includes("UPDATE sellers SET business_details"))).toBe(false);
  });

  it("filtrul de eligibilitate exclude comenzile închise și fereastra de retur", async () => {
    eligible = [{ id: "i1", amt: 9000 }];
    await requestSellerPayout({ sellerId: "s1", iban: IBAN });
    const lock = calls.find((c) => c.sql.includes("FOR UPDATE OF coi"));
    expect(lock?.params[1]).toBe("14");
    expect(lock?.params[3]).toEqual(expect.arrayContaining(["refunded", "cancelled", "return_requested", "pending"]));
  });
});

describe("resolveSellerPayout", () => {
  it("cererea nu mai e pending → not_pending", async () => {
    pending = false;
    expect(await resolveSellerPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: false, code: "not_pending" });
  });

  it("respinsă → item-urile revin în sold", async () => {
    const res = await resolveSellerPayout({ id: "pr1", action: "rejected", note: "IBAN greșit" });
    expect(res).toMatchObject({ ok: true, status: "rejected" });
    expect(calls.some((c) => c.sql.includes("'{\"seller_payout_status\":\"pending\"}'") && c.params[0] === "pr1")).toBe(true);
  });

  it("plătită fără Connect → confirmare bancară, suma recalculată, fără transfer Stripe", async () => {
    requestedSum = 6000;
    const res = await resolveSellerPayout({ id: "pr1", action: "paid", note: null });
    expect(res).toEqual({ ok: true, status: "paid", via: "bank", amountCents: 6000 });
    expect(transfers).not.toHaveBeenCalled();
    const final = calls.find((c) => c.sql.includes("SET status = 'paid'"));
    expect(final?.params).toEqual(["pr1", null, 6000]);
  });

  it("plătită cu Connect → transfer Stripe idempotent", async () => {
    connectFlag = true;
    seller = { account_id: "acct_9", ready: true, iban: null };
    requestedSum = 7000;
    transfers.mockResolvedValue({ id: "tr_1" });
    const res = await resolveSellerPayout({ id: "pr1", action: "paid", note: null });
    expect(res).toMatchObject({ ok: true, via: "stripe" });
    expect(transfers).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7000, currency: "ron", destination: "acct_9" }),
      { idempotencyKey: "seller_payout:pr1" },
    );
  });

  it("transfer eșuat → cererea revine în pending cu motivul", async () => {
    connectFlag = true;
    seller = { account_id: "acct_9", ready: true, iban: null };
    requestedSum = 7000;
    transfers.mockRejectedValue(new Error("insufficient platform balance"));
    expect(await resolveSellerPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: false, code: "transfer_failed" });
    expect(calls.some((c) => c.sql.includes("SET status = 'pending', failure_reason"))).toBe(true);
  });

  it("toate item-urile rambursate între timp → nothing_to_pay, cererea se închide", async () => {
    requestedSum = 0;
    expect(await resolveSellerPayout({ id: "pr1", action: "paid", note: null })).toEqual({ ok: false, code: "nothing_to_pay" });
    expect(calls.some((c) => c.sql.includes("'nothing_to_pay'"))).toBe(true);
  });
});
