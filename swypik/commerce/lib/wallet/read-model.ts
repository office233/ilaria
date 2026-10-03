import { dbQuery } from "@/lib/db";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";

export type WalletActivity = {
  id: string;
  kind: "credit" | "debit";
  amountCents: number;
  balanceAfterCents: number;
  refType: string;
  refId: string;
  createdAt: string;
};

export type WalletSnapshot = {
  balanceCents: number;
  currency: string;
  totalCreditsCents: number;
  totalDebitsCents: number;
  activity: WalletActivity[];
  nextCursor: string | null;
};

function safeCents(value: string | number | null | undefined, field: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new Error(`wallet_${field}_outside_safe_integer_range`);
  return parsed;
}

export async function getWalletSnapshot(
  userId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<WalletSnapshot> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const cursor = opts.cursor?.trim() || null;
  if (cursor && !/^\d+$/.test(cursor)) throw new Error("invalid_wallet_cursor");

  const [balance, totals, entries] = await Promise.all([
    dbQuery<{ balance_cents: string; currency: string }>(
      `SELECT balance_cents::text, currency
         FROM wallet_balances
        WHERE user_id = $1`,
      [userId],
    ),
    dbQuery<{ credits: string; debits: string }>(
      `SELECT
         COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'credit'), 0)::text AS credits,
         COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'debit'), 0)::text AS debits
       FROM wallet_ledger_entries
       WHERE user_id = $1`,
      [userId],
    ),
    dbQuery<{
      id: string;
      kind: "credit" | "debit";
      amount_cents: string;
      balance_after_cents: string;
      ref_type: string;
      ref_id: string;
      created_at: string;
    }>(
      `SELECT id::text, kind, amount_cents::text, balance_after_cents::text,
              ref_type, ref_id, created_at::text
         FROM wallet_ledger_entries
        WHERE user_id = $1
          AND ($2::bigint IS NULL OR id < $2::bigint)
        ORDER BY id DESC
        LIMIT $3`,
      [userId, cursor, limit + 1],
    ),
  ]);

  const rows = entries.rows.slice(0, limit);
  const balanceRow = balance.rows[0];
  const totalsRow = totals.rows[0];

  return {
    balanceCents: safeCents(balanceRow?.balance_cents, "balance_cents"),
    currency: balanceRow?.currency?.trim().toUpperCase() || DEFAULT_CURRENCY,
    totalCreditsCents: safeCents(totalsRow?.credits, "credits_cents"),
    totalDebitsCents: safeCents(totalsRow?.debits, "debits_cents"),
    activity: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amountCents: safeCents(row.amount_cents, "amount_cents"),
      balanceAfterCents: safeCents(row.balance_after_cents, "balance_after_cents"),
      refType: row.ref_type,
      refId: row.ref_id,
      createdAt: row.created_at,
    })),
    nextCursor: entries.rows.length > limit ? rows.at(-1)?.id ?? null : null,
  };
}
