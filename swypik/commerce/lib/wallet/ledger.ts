/**
 * Ledger monetar (cenți) — creditUser / debitUser.
 *
 * Garanții:
 *  - tranzacție unică cu SELECT ... FOR UPDATE pe wallet_balances → fără
 *    race conditions la creditări/debitări concurente;
 *  - idempotent după (ref_type, ref_id, kind): dacă intrarea există deja,
 *    e no-op și returnează intrarea existentă (alreadyApplied=true);
 *  - debit refuzat dacă soldul ar deveni negativ (InsufficientFundsError).
 *
 * Tabele: wallet_balances (sold curent), wallet_ledger_entries (append-only).
 * Vezi db/migrations/20260730_0002_wallet_ledger_cents.sql.
 */
import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type LedgerEntry = {
  id: string;
  user_id: string;
  kind: "credit" | "debit";
  amount_cents: number;
  balance_after_cents: number;
  ref_type: string;
  ref_id: string;
  description: string | null;
  created_at: string;
};

export type LedgerResult = {
  entry: LedgerEntry;
  /** true dacă intrarea exista deja (idempotent no-op). */
  alreadyApplied: boolean;
};

export class InsufficientFundsError extends Error {
  constructor(public readonly balanceCents: number, public readonly requestedCents: number) {
    super(`insufficient_funds: balance=${balanceCents} requested=${requestedCents}`);
    this.name = "InsufficientFundsError";
  }
}

export class LedgerIdempotencyConflictError extends Error {
  constructor(
    public readonly refType: string,
    public readonly refId: string,
    public readonly kind: "credit" | "debit",
  ) {
    super(`ledger_idempotency_conflict: ${refType}/${refId}/${kind}`);
    this.name = "LedgerIdempotencyConflictError";
  }
}

export type NegativeBalanceReason =
  | "cash_custody_debt"
  | "settlement_reversal"
  | "refund_clawback";

export type ApplyArgs = {
  userId: string;
  amountCents: number;
  refType: string;
  refId: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /**
   * Excepție financiară explicită. Un debit poate coborî soldul sub zero doar
   * dacă motivul este compatibil cu refType-ul; booleanul generic
   * allowNegative a fost eliminat ca apelanții noi să nu poată ocoli accidental
   * protecția de insufficient funds.
   */
  negativeBalanceReason?: NegativeBalanceReason;
};

type LedgerEntryDb = Omit<LedgerEntry, "amount_cents" | "balance_after_cents"> & {
  amount_cents: string | number;
  balance_after_cents: string | number;
};

const ENTRY_COLS = `id::text, user_id, kind, amount_cents::text AS amount_cents,
       balance_after_cents::text AS balance_after_cents,
       ref_type, ref_id, description, created_at::text`;

const NEGATIVE_BALANCE_REF_TYPES: Record<NegativeBalanceReason, ReadonlySet<string>> = {
  cash_custody_debt: new Set(["ride", "order"]),
  settlement_reversal: new Set([
    "creator_commission_reversal",
    "order_reversal",
    "commission_order_reversal",
    "movie_creator_share_reversal",
    "music_artist_share_reversal",
  ]),
  refund_clawback: new Set(["stay_refund_clawback"]),
};

function validateNegativeBalancePolicy(args: ApplyArgs): void {
  const reason = args.negativeBalanceReason;
  if (!reason) return;
  if (!NEGATIVE_BALANCE_REF_TYPES[reason].has(args.refType)) {
    throw new Error(
      `wallet_negative_balance_policy_mismatch:${reason}:${args.refType}`,
    );
  }
}

function centsNumber(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`wallet_${field}_outside_safe_integer_range`);
  }
  return parsed;
}

function normalizeEntry(row: LedgerEntryDb): LedgerEntry {
  return {
    ...row,
    amount_cents: centsNumber(row.amount_cents, "amount_cents"),
    balance_after_cents: centsNumber(row.balance_after_cents, "balance_after_cents"),
  };
}

function existingResult(row: LedgerEntryDb, kind: "credit" | "debit", args: ApplyArgs): LedgerResult {
  const entry = normalizeEntry(row);
  if (entry.user_id !== args.userId || entry.kind !== kind || entry.amount_cents !== args.amountCents) {
    throw new LedgerIdempotencyConflictError(args.refType, args.refId, kind);
  }
  return { entry, alreadyApplied: true };
}

/**
 * Aplică o intrare în ledger folosind tranzacția deschisă de apelant (`q`).
 * Folosit când creditarea trebuie să fie atomică cu alte scrieri (ex. plata
 * premiului unei misiuni + decrementarea escrow-ului) — fără tranzacții imbricate.
 */
async function applyWith(q: TxQuery, kind: "credit" | "debit", args: ApplyArgs): Promise<LedgerResult> {
  const {
    userId,
    amountCents,
    refType,
    refId,
    description,
    metadata,
    negativeBalanceReason,
  } = args;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("amount_cents must be a positive safe integer");
  }
  validateNegativeBalancePolicy(args);
  // 1. Idempotency check (inside the tx so concurrent duplicates serialize
  //    on the unique constraint below, not on this read).
  const existing = await q<LedgerEntryDb>(
    `SELECT ${ENTRY_COLS} FROM wallet_ledger_entries
      WHERE ref_type = $1 AND ref_id = $2 AND kind = $3 LIMIT 1`,
    [refType, refId, kind],
  );
  if (existing.rows[0]) {
    return existingResult(existing.rows[0], kind, args);
  }

  // 2. Ensure the balance row exists, then lock it.
  await q(
    `INSERT INTO wallet_balances (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const locked = await q<{ balance_cents: string }>(
    `SELECT balance_cents FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  // The first request may have committed while this one waited on the wallet
  // lock. Re-check BEFORE insufficient-funds/overflow validation: its debit
  // may have consumed the balance, but an identical retry is still a success.
  const afterLock = await q<LedgerEntryDb>(
    `SELECT ${ENTRY_COLS} FROM wallet_ledger_entries
      WHERE ref_type = $1 AND ref_id = $2 AND kind = $3 LIMIT 1`,
    [refType, refId, kind],
  );
  if (afterLock.rows[0]) return existingResult(afterLock.rows[0], kind, args);
  if (!locked.rows[0]) throw new Error("wallet_balance_row_missing");
  const balance = centsNumber(locked.rows[0].balance_cents, "balance_cents");

  const delta = kind === "credit" ? amountCents : -amountCents;
  const newBalance = centsNumber(balance + delta, "balance_after_cents");
  // Doar debitele pot fi refuzate: un CREDIT mărește mereu soldul, deci e
  // permis și pe sold negativ (stinge datoria de comision cash).
  if (kind === "debit" && newBalance < 0 && !negativeBalanceReason) {
    throw new InsufficientFundsError(balance, amountCents);
  }

  // 3. Write ledger entry. ON CONFLICT DO NOTHING handles the race where
  //    two identical requests pass the read in step 1 simultaneously:
  //    the loser re-reads and returns the winner's entry (no-op).
  const inserted = await q<LedgerEntryDb>(
    `INSERT INTO wallet_ledger_entries
       (user_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (ref_type, ref_id, kind) DO NOTHING
     RETURNING ${ENTRY_COLS}`,
    [
      userId,
      kind,
      amountCents,
      newBalance,
      refType,
      refId,
      description ?? null,
      JSON.stringify(metadata ?? {}),
    ],
  );

  if (!inserted.rows[0]) {
    // Duplicate raced us — return the winner's entry without touching balance.
    const winner = await q<LedgerEntryDb>(
      `SELECT ${ENTRY_COLS} FROM wallet_ledger_entries
        WHERE ref_type = $1 AND ref_id = $2 AND kind = $3 LIMIT 1`,
      [refType, refId, kind],
    );
    if (!winner.rows[0]) throw new Error("wallet_idempotency_winner_missing");
    return existingResult(winner.rows[0], kind, args);
  }

  // 4. Update the balance in the same transaction.
  await q(
    `UPDATE wallet_balances
        SET balance_cents = $2, updated_at = now()
      WHERE user_id = $1`,
    [userId, newBalance],
  );

  logger.info(
    { userId, kind, amountCents, refType, refId, balanceAfter: newBalance },
    "wallet.ledger.applied",
  );

  return { entry: normalizeEntry(inserted.rows[0]), alreadyApplied: false };
}

async function apply(kind: "credit" | "debit", args: ApplyArgs): Promise<LedgerResult> {
  if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
    throw new Error("amount_cents must be a positive safe integer");
  }
  return withTransaction((q) => applyWith(q, kind, args));
}

/** Creditează în tranzacția apelantului. Idempotent după (refType, refId, 'credit'). */
export function creditUserTx(q: TxQuery, args: ApplyArgs): Promise<LedgerResult> {
  return applyWith(q, "credit", args);
}

/** Debitează în tranzacția apelantului. Idempotent după (refType, refId, 'debit'). */
export function debitUserTx(q: TxQuery, args: ApplyArgs): Promise<LedgerResult> {
  return applyWith(q, "debit", args);
}

/** Creditează contul (cenți). Idempotent după (refType, refId, 'credit'). */
export function creditUser(args: ApplyArgs): Promise<LedgerResult> {
  return apply("credit", args);
}

/** Debitează contul (cenți). Idempotent după (refType, refId, 'debit'). */
export function debitUser(args: ApplyArgs): Promise<LedgerResult> {
  return apply("debit", args);
}

/** Soldul curent în cenți (0 dacă nu există wallet). */
export async function getBalanceCents(userId: string): Promise<number> {
  const { rows } = await dbQuery<{ balance_cents: string }>(
    `SELECT balance_cents FROM wallet_balances WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? centsNumber(rows[0].balance_cents, "balance_cents") : 0;
}
