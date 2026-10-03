import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { rows: any[]; rowCount: number };
const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  dbQuery: (...args: unknown[]) => query(...args),
  withTransaction: async (fn: (q: typeof query) => Promise<unknown>) => fn(query),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  creditUser,
  debitUser,
  getBalanceCents,
  InsufficientFundsError,
} from "@/lib/wallet/ledger";

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  query.mockReset();
});

describe("wallet ledger numeric boundary", () => {
  it("normalizes pg bigint strings to runtime numbers", async () => {
    query.mockImplementation(async (sql: string): Promise<Result> => {
      if (sql.includes("WHERE ref_type = $1")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO wallet_balances")) return { rows: [], rowCount: 1 };
      if (sql.includes("FOR UPDATE")) return { rows: [{ balance_cents: "2500" }], rowCount: 1 };
      if (sql.includes("INSERT INTO wallet_ledger_entries")) {
        return {
          rows: [{
            id: "1",
            user_id: USER,
            kind: "credit",
            amount_cents: "500",
            balance_after_cents: "3000",
            ref_type: "test",
            ref_id: "r1",
            description: null,
            created_at: "2026-09-29T00:00:00Z",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await creditUser({
      userId: USER,
      amountCents: 500,
      refType: "test",
      refId: "r1",
    });
    expect(result.entry.amount_cents).toBe(500);
    expect(result.entry.balance_after_cents).toBe(3000);
    expect(typeof result.entry.balance_after_cents).toBe("number");
  });

  it("normalizes idempotent existing entries as well", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: "1",
        user_id: USER,
        kind: "credit",
        amount_cents: "500",
        balance_after_cents: "3000",
        ref_type: "test",
        ref_id: "r1",
        description: null,
        created_at: "2026-09-29T00:00:00Z",
      }],
      rowCount: 1,
    });

    const result = await creditUser({
      userId: USER,
      amountCents: 500,
      refType: "test",
      refId: "r1",
    });
    expect(result.alreadyApplied).toBe(true);
    expect(result.entry.balance_after_cents).toBe(3000);
  });

  it("refuses values outside JavaScript safe-integer precision", async () => {
    query.mockResolvedValueOnce({ rows: [{ balance_cents: "9007199254740992" }], rowCount: 1 });
    await expect(getBalanceCents(USER)).rejects.toThrow("wallet_balance_cents_outside_safe_integer_range");
  });

  it("refuses a normal debit that would push the balance below zero", async () => {
    query.mockImplementation(async (sql: string): Promise<Result> => {
      if (sql.includes("WHERE ref_type = $1")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO wallet_balances")) return { rows: [], rowCount: 1 };
      if (sql.includes("FOR UPDATE")) return { rows: [{ balance_cents: "100" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await expect(
      debitUser({
        userId: USER,
        amountCents: 150,
        refType: "purchase",
        refId: "p1",
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it("rejects an explicit negative-balance reason when its refType is not whitelisted", async () => {
    await expect(
      debitUser({
        userId: USER,
        amountCents: 50,
        refType: "purchase",
        refId: "p2",
        negativeBalanceReason: "cash_custody_debt",
      }),
    ).rejects.toThrow(
      "wallet_negative_balance_policy_mismatch:cash_custody_debt:purchase",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("allows an approved cash-custody debt to create a negative balance", async () => {
    query.mockImplementation(async (sql: string): Promise<Result> => {
      if (sql.includes("WHERE ref_type = $1")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO wallet_balances")) return { rows: [], rowCount: 1 };
      if (sql.includes("FOR UPDATE")) return { rows: [{ balance_cents: "100" }], rowCount: 1 };
      if (sql.includes("INSERT INTO wallet_ledger_entries")) {
        return {
          rows: [{
            id: "debt-1",
            user_id: USER,
            kind: "debit",
            amount_cents: "250",
            balance_after_cents: "-150",
            ref_type: "ride",
            ref_id: "ride-1",
            description: null,
            created_at: "2026-09-29T00:00:00Z",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE wallet_balances")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await debitUser({
      userId: USER,
      amountCents: 250,
      refType: "ride",
      refId: "ride-1",
      negativeBalanceReason: "cash_custody_debt",
    });
    expect(result.entry.balance_after_cents).toBe(-150);
    expect(result.alreadyApplied).toBe(false);
  });
});
