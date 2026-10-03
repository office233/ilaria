import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({
  dbQuery: h.query,
  withTransaction: async (fn: (query: typeof h.query) => Promise<unknown>) => fn(h.query),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn() } }));
import { creditUser, debitUser, LedgerIdempotencyConflictError } from "@/lib/wallet/ledger";

const args = { userId: "user-1", amountCents: 500, refType: "purchase", refId: "purchase-1" };
function entry(kind: "credit" | "debit" = "debit") {
  return {
    id: "entry-1", user_id: args.userId, kind, amount_cents: "500",
    balance_after_cents: "0", ref_type: args.refType, ref_id: args.refId,
    description: null, created_at: "2026-09-30T00:00:00Z",
  };
}
beforeEach(() => { h.query.mockReset(); });

describe("wallet retries and precision", () => {
  it("returns the first debit when a concurrent retry acquires an already-drained wallet", async () => {
    let lookups = 0;
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM wallet_ledger_entries")) {
        lookups += 1;
        return { rows: lookups === 1 ? [] : [entry()] };
      }
      if (sql.includes("FOR UPDATE")) return { rows: [{ balance_cents: "0" }] };
      return { rows: [] };
    });
    await expect(debitUser(args)).resolves.toMatchObject({ alreadyApplied: true, entry: { amount_cents: 500 } });
    expect(h.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO wallet_ledger_entries"))).toBe(false);
    expect(h.query.mock.calls.some(([sql]) => sql.includes("UPDATE wallet_balances"))).toBe(false);
  });

  it.each([{ user_id: "another-user" }, { amount_cents: "499" }])("rejects reusing a reference for a different effect: %o", async (change) => {
    h.query.mockResolvedValue({ rows: [{ ...entry(), ...change }] });
    await expect(debitUser(args)).rejects.toBeInstanceOf(LedgerIdempotencyConflictError);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it("validates the winning effect after a different-wallet unique constraint race", async () => {
    let lookups = 0;
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM wallet_ledger_entries")) {
        lookups += 1;
        return { rows: lookups < 3 ? [] : [{ ...entry("credit"), user_id: "another-user" }] };
      }
      if (sql.includes("FOR UPDATE")) return { rows: [{ balance_cents: "0" }] };
      return { rows: [] };
    });
    await expect(creditUser(args)).rejects.toBeInstanceOf(LedgerIdempotencyConflictError);
    expect(h.query.mock.calls.some(([sql]) => sql.includes("UPDATE wallet_balances"))).toBe(false);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Infinity, 1.5])("rejects imprecise amount %s before querying", async (amountCents) => {
    await expect(creditUser({ ...args, amountCents })).rejects.toThrow("positive safe integer");
    expect(h.query).not.toHaveBeenCalled();
  });

  it("rejects balance overflow before inserting any ledger entry", async () => {
    h.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FOR UPDATE") ? [{ balance_cents: String(Number.MAX_SAFE_INTEGER) }] : [],
    }));
    await expect(creditUser({ ...args, amountCents: 1 })).rejects.toThrow("wallet_balance_after_cents_outside_safe_integer_range");
    expect(h.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO wallet_ledger_entries"))).toBe(false);
  });
});
