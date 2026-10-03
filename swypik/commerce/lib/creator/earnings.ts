/**
 * Câștigurile creatorului — citite EXCLUSIV din portofelul RON
 * (wallet_ledger_entries + wallet_balances). Aceeași sursă pentru pagina de
 * câștiguri, dashboard, API și retrageri; nu se mai recalculează comisionul la
 * citire și nu se mai citesc tabelele commissions/commission_payouts (goale).
 *
 * Singura valoare estimată: `pendingCommissionCents` — comisionul pe vânzările
 * încă în fereastra de retur (se creditează în portofel la maturare).
 */
import { dbQuery } from "@/lib/db";
import { creatorCommissionCents, UNPAID_ITEM_STATUSES } from "./commission";

export type EarningSource = "commissions" | "missions" | "movies" | "music" | "fund";

/** ref_type din ledger → sursa de câștig (reversările scad din aceeași sursă). */
export const EARNING_REF_TYPES: Record<string, EarningSource> = {
  creator_commission: "commissions",
  creator_commission_reversal: "commissions",
  mission_prize: "missions",
  movie_creator_share: "movies",
  movie_creator_share_reversal: "movies",
  music_artist_share: "music",
  music_artist_share_reversal: "music",
  creator_fund_payout: "fund",
};
/** Retrageri: debit la cerere, credit înapoi la respingere. */
export const PAYOUT_REF_TYPES = ["payout", "payout_refund"];

export type LedgerAggregateRow = { ref_type: string; kind: "credit" | "debit"; cents: number | string };

export type LedgerSummary = {
  bySource: Record<EarningSource, number>;
  totalEarnedCents: number;
  withdrawnCents: number;
};

export function summarizeLedger(rows: LedgerAggregateRow[]): LedgerSummary {
  const bySource: Record<EarningSource, number> = { commissions: 0, missions: 0, movies: 0, music: 0, fund: 0 };
  let withdrawn = 0;
  for (const r of rows) {
    const cents = Number(r.cents) || 0;
    const signed = r.kind === "credit" ? cents : -cents;
    const source = EARNING_REF_TYPES[r.ref_type];
    if (source) bySource[source] += signed;
    else if (PAYOUT_REF_TYPES.includes(r.ref_type)) withdrawn -= signed; // debit payout = +retras
  }
  const totalEarnedCents = Object.values(bySource).reduce((a, b) => a + b, 0);
  return { bySource, totalEarnedCents, withdrawnCents: Math.max(0, withdrawn) };
}

export type LedgerEntryView = {
  id: string;
  kind: "credit" | "debit";
  amountCents: number;
  refType: string;
  source: EarningSource | "payout";
  createdAt: string;
};

export type CreatorEarnings = LedgerSummary & {
  balanceCents: number;
  thisMonthEarnedCents: number;
  pendingCommissionCents: number;
  pendingPayoutCents: number;
  recent: LedgerEntryView[];
};

const ALL_REF_TYPES = [...Object.keys(EARNING_REF_TYPES), ...PAYOUT_REF_TYPES];

export async function getCreatorEarnings(userId: string): Promise<CreatorEarnings> {
  const [agg, month, balance, pendingItems, pendingPayout, recent] = await Promise.all([
    dbQuery<LedgerAggregateRow>(
      `SELECT ref_type, kind, COALESCE(SUM(amount_cents), 0)::text AS cents
         FROM wallet_ledger_entries
        WHERE user_id = $1 AND ref_type = ANY($2::text[])
        GROUP BY ref_type, kind`,
      [userId, ALL_REF_TYPES],
    ),
    dbQuery<LedgerAggregateRow>(
      `SELECT ref_type, kind, COALESCE(SUM(amount_cents), 0)::text AS cents
         FROM wallet_ledger_entries
        WHERE user_id = $1 AND ref_type = ANY($2::text[]) AND created_at >= date_trunc('month', now())
        GROUP BY ref_type, kind`,
      [userId, Object.keys(EARNING_REF_TYPES)],
    ),
    dbQuery<{ balance_cents: string }>(`SELECT balance_cents::text FROM wallet_balances WHERE user_id = $1`, [userId]),
    dbQuery<{ base: string }>(
      `SELECT COALESCE(SUM(coi.commissionable_amount_cents), 0)::text AS base
         FROM commerce_order_items coi
         LEFT JOIN commerce_orders co ON co.id = coi.order_id
        WHERE coi.creator_id = $1
          AND (coi.payout_status IS NULL OR coi.payout_status = ANY($2::text[]))
          AND coi.commissionable_amount_cents > 0
          AND (co.status IS NULL OR co.status NOT IN ('refunded', 'cancelled', 'failed'))`,
      [userId, UNPAID_ITEM_STATUSES],
    ),
    dbQuery<{ cents: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS cents FROM payout_requests
        WHERE user_id = $1 AND status IN ('pending', 'processing')`,
      [userId],
    ),
    dbQuery<{ id: string; kind: "credit" | "debit"; amount_cents: string; ref_type: string; created_at: string }>(
      `SELECT id::text, kind, amount_cents::text, ref_type, created_at::text
         FROM wallet_ledger_entries
        WHERE user_id = $1 AND ref_type = ANY($2::text[])
        ORDER BY created_at DESC
        LIMIT 20`,
      [userId, ALL_REF_TYPES],
    ),
  ]);

  const summary = summarizeLedger(agg.rows);
  return {
    ...summary,
    balanceCents: Number(balance.rows[0]?.balance_cents ?? 0),
    thisMonthEarnedCents: summarizeLedger(month.rows).totalEarnedCents,
    pendingCommissionCents: creatorCommissionCents(Number(pendingItems.rows[0]?.base ?? 0)),
    pendingPayoutCents: Number(pendingPayout.rows[0]?.cents ?? 0),
    recent: recent.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: Number(r.amount_cents),
      refType: r.ref_type,
      source: EARNING_REF_TYPES[r.ref_type] ?? "payout",
      createdAt: r.created_at,
    })),
  };
}
