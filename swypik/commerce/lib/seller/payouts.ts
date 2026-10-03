/**
 * Retrageri pentru selleri — payout_requests, kind = 'seller' (aceeași coadă de
 * aprobare ca pentru creatori/curieri; vezi migrarea 20260926_0090).
 *
 * Soldul NU e în portofelul RON: e suma `seller_payout_cents` a item-urilor
 * expediate, ieșite din fereastra de retur (RETURN_WINDOW_DAYS) sau livrate,
 * din comenzi neanulate/nerambursate.
 *
 * Cerere (seller): TOT soldul disponibil; item-urile trec atomic în
 * `seller_payout_status = 'requested'` (+ seller_payout_request_id) — nu pot fi
 * cerute de două ori și cronul Stripe Connect nu le mai vede.
 * Rezolvare (admin):
 *   - 'paid' + Connect disponibil (flag + cheie) + contul seller-ului activ → transfer Stripe;
 *   - 'paid' altfel → adminul confirmă transferul bancar manual (IBAN);
 *   - 'rejected' → item-urile revin în sold.
 */
import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { stripeConnectAvailable } from "@/lib/creator/payouts";
import { logger } from "@/lib/logger";
import { sellerCurrency, sellerPayoutMinCents, sellerReturnWindowDays } from "./config";

/** Stări de payout ale unui item care pot fi încă retrase. */
const WITHDRAWABLE = ["pending", "no_account", "restricted", "failed"];
const CLOSED_ORDER = ["pending", "authorized", "refunded", "cancelled", "return_requested", "failed"];

/** Condiția „item retrăgibil acum” ($1 = seller, $2 = zile fereastră, $3 = stări, $4 = comenzi închise). */
const ELIGIBLE_SQL = `
  coi.metadata->>'seller_id' = $1
  AND coi.source_status = 'fulfilled'
  AND NULLIF(coi.metadata->>'seller_payout_cents', '')::int > 0
  AND (coi.metadata->>'seller_payout_status' IS NULL OR coi.metadata->>'seller_payout_status' = ANY($3::text[]))
  AND (coi.metadata ? 'delivered_at'
       OR COALESCE(NULLIF(coi.metadata->>'fulfilled_at', '')::timestamptz, coi.updated_at) < now() - ($2 || ' days')::interval)
  AND co.status <> ALL($4::text[])`;

export type SellerPayoutSetup = {
  method: "stripe" | "bank";
  connectAvailable: boolean;
  connectReady: boolean;
  minCents: number;
  windowDays: number;
  currency: string;
  iban: string | null;
};

export async function getSellerPayoutSetup(sellerId: string): Promise<SellerPayoutSetup & { accountId: string | null }> {
  const { rows } = await dbQuery<{ account_id: string | null; ready: boolean | null; iban: string | null }>(
    `SELECT COALESCE(stripe_account_id, metadata->>'stripe_account_id') AS account_id,
            stripe_payouts_enabled AS ready, NULLIF(business_details->>'iban', '') AS iban
       FROM sellers WHERE id = $1`,
    [sellerId],
  );
  const connectAvailable = stripeConnectAvailable();
  const connectReady = connectAvailable && !!rows[0]?.account_id && !!rows[0]?.ready;
  return {
    method: connectReady ? "stripe" : "bank",
    connectAvailable,
    connectReady,
    minCents: sellerPayoutMinCents(),
    windowDays: sellerReturnWindowDays(),
    currency: sellerCurrency(),
    iban: rows[0]?.iban ?? null,
    accountId: rows[0]?.account_id ?? null,
  };
}

export type SellerBalance = {
  availableCents: number;
  onHoldCents: number;
  requestedCents: number;
  paidTotalCents: number;
  paid90Cents: number;
};

export async function getSellerBalance(sellerId: string): Promise<SellerBalance> {
  const { rows } = await dbQuery<Record<string, string | number>>(
    `SELECT
       COALESCE(SUM(amt) FILTER (WHERE eligible), 0)::bigint AS available,
       COALESCE(SUM(amt) FILTER (WHERE NOT eligible AND open AND co_status <> ALL($4::text[])), 0)::bigint AS on_hold,
       COALESCE(SUM(amt) FILTER (WHERE pstatus = 'requested'), 0)::bigint AS requested,
       COALESCE(SUM(amt) FILTER (WHERE pstatus = 'paid'), 0)::bigint AS paid_total,
       COALESCE(SUM(amt) FILTER (WHERE pstatus = 'paid' AND paid_at > now() - interval '90 days'), 0)::bigint AS paid_90
     FROM (
       SELECT NULLIF(coi.metadata->>'seller_payout_cents', '')::int AS amt,
              coi.metadata->>'seller_payout_status' AS pstatus,
              NULLIF(coi.metadata->>'seller_payout_paid_at', '')::timestamptz AS paid_at,
              co.status AS co_status,
              (coi.metadata->>'seller_payout_status' IS NULL OR coi.metadata->>'seller_payout_status' = ANY($3::text[])) AS open,
              (${ELIGIBLE_SQL}) AS eligible
         FROM commerce_order_items coi
         JOIN commerce_orders co ON co.id = coi.order_id
        WHERE coi.metadata->>'seller_id' = $1 AND coi.source_status <> 'cancelled'
          AND NULLIF(coi.metadata->>'seller_payout_cents', '')::int > 0
     ) t`,
    [sellerId, String(sellerReturnWindowDays()), WITHDRAWABLE, CLOSED_ORDER],
  );
  const r = rows[0] ?? {};
  return {
    availableCents: Number(r.available ?? 0),
    onHoldCents: Number(r.on_hold ?? 0),
    requestedCents: Number(r.requested ?? 0),
    paidTotalCents: Number(r.paid_total ?? 0),
    paid90Cents: Number(r.paid_90 ?? 0),
  };
}

export type SellerPayoutRequestView = {
  id: string;
  amountCents: number;
  status: string;
  iban: string | null;
  adminNote: string | null;
  failureReason: string | null;
  requestedAt: string;
  resolvedAt: string | null;
};

export function maskIban(iban: string | null): string | null {
  return iban ? `•••• ${iban.slice(-4)}` : null;
}

export async function listSellerPayoutRequests(sellerId: string): Promise<SellerPayoutRequestView[]> {
  const { rows } = await dbQuery<{
    id: string; amount_cents: string; status: string; iban: string | null; admin_note: string | null;
    failure_reason: string | null; requested_at: string; resolved_at: string | null;
  }>(
    `SELECT id, amount_cents::text, status, iban, admin_note, failure_reason, requested_at::text, resolved_at::text
       FROM payout_requests WHERE seller_id = $1 AND kind = 'seller'
      ORDER BY requested_at DESC LIMIT 50`,
    [sellerId],
  );
  return rows.map((r) => ({
    id: r.id,
    amountCents: Number(r.amount_cents),
    status: r.status,
    iban: maskIban(r.iban),
    adminNote: r.admin_note,
    failureReason: r.failure_reason,
    requestedAt: r.requested_at,
    resolvedAt: r.resolved_at,
  }));
}

export type SellerPayoutRequestResult =
  | { ok: true; id: string; amountCents: number; method: "stripe" | "bank" }
  | { ok: false; code: "below_minimum" | "iban_required" | "open_request_exists"; availableCents?: number };

async function lockEligibleItems(q: TxQuery, sellerId: string): Promise<Array<{ id: string; amt: number }>> {
  const { rows } = await q<{ id: string; amt: string | number }>(
    `SELECT coi.id::text AS id, NULLIF(coi.metadata->>'seller_payout_cents', '')::int AS amt
       FROM commerce_order_items coi JOIN commerce_orders co ON co.id = coi.order_id
      WHERE ${ELIGIBLE_SQL}
      ORDER BY coi.id
      FOR UPDATE OF coi`,
    [sellerId, String(sellerReturnWindowDays()), WITHDRAWABLE, CLOSED_ORDER],
  );
  return rows.map((r) => ({ id: r.id, amt: Number(r.amt) }));
}

export async function requestSellerPayout(args: { sellerId: string; iban: string | null }): Promise<SellerPayoutRequestResult> {
  const setup = await getSellerPayoutSetup(args.sellerId);
  const iban = args.iban ?? setup.iban;
  if (setup.method === "bank" && !iban) return { ok: false, code: "iban_required" };

  return withTransaction(async (q) => {
    const items = await lockEligibleItems(q, args.sellerId);
    const amountCents = items.reduce((acc, i) => acc + i.amt, 0);
    if (amountCents < setup.minCents) return { ok: false, code: "below_minimum", availableCents: amountCents };

    const { rows } = await q<{ id: string }>(
      `INSERT INTO payout_requests (seller_id, user_id, kind, amount_cents, currency, iban, note)
       SELECT $1, NULL, 'seller', $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM payout_requests WHERE seller_id = $1 AND kind = 'seller' AND status IN ('pending', 'processing'))
       RETURNING id`,
      [args.sellerId, amountCents, setup.currency, setup.method === "bank" ? iban : null, `method:${setup.method}`],
    );
    const id = rows[0]?.id;
    if (!id) return { ok: false, code: "open_request_exists" };

    await q(
      `UPDATE commerce_order_items
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'seller_payout_status', 'requested', 'seller_payout_request_id', $2::text)
        WHERE id = ANY($1::uuid[])`,
      [items.map((i) => i.id), id],
    );
    if (args.iban && args.iban !== setup.iban) {
      await q(
        `UPDATE sellers SET business_details = COALESCE(business_details, '{}'::jsonb) || jsonb_build_object('iban', $2::text),
                updated_at = now() WHERE id = $1`,
        [args.sellerId, args.iban],
      );
    }
    logger.info({ payoutId: id, sellerId: args.sellerId, amountCents, method: setup.method }, "seller.payout.requested");
    return { ok: true, id, amountCents, method: setup.method };
  });
}

export type SellerPayoutResolveResult =
  | { ok: true; status: "paid" | "rejected"; via: "stripe" | "bank" | null; amountCents: number }
  | { ok: false; code: "not_pending" | "transfer_failed" | "nothing_to_pay" };

async function releaseItems(q: TxQuery, id: string): Promise<void> {
  await q(
    `UPDATE commerce_order_items
        SET metadata = (metadata - 'seller_payout_request_id') || '{"seller_payout_status":"pending"}'::jsonb
      WHERE metadata->>'seller_payout_request_id' = $1 AND metadata->>'seller_payout_status' = 'requested'`,
    [id],
  );
}

export async function resolveSellerPayout(args: { id: string; action: "paid" | "rejected"; note: string | null }): Promise<SellerPayoutResolveResult> {
  const { rows } = await dbQuery<{ id: string; seller_id: string }>(
    `UPDATE payout_requests SET status = 'processing', admin_note = $2
      WHERE id = $1 AND kind = 'seller' AND status = 'pending'
      RETURNING id, seller_id::text`,
    [args.id, args.note],
  );
  const pr = rows[0];
  if (!pr) return { ok: false, code: "not_pending" };

  if (args.action === "rejected") {
    await withTransaction(async (q) => {
      await releaseItems(q, pr.id);
      await q(`UPDATE payout_requests SET status = 'rejected', resolved_at = now(), resolved_by = 'admin' WHERE id = $1`, [pr.id]);
    });
    return { ok: true, status: "rejected", via: null, amountCents: 0 };
  }

  // Suma se recalculează: un item rambursat între timp a ieșit din cerere.
  const { rows: sumRows } = await dbQuery<{ amount: string | number }>(
    `SELECT COALESCE(SUM(NULLIF(metadata->>'seller_payout_cents', '')::int), 0)::bigint AS amount
       FROM commerce_order_items
      WHERE metadata->>'seller_payout_request_id' = $1 AND metadata->>'seller_payout_status' = 'requested'`,
    [pr.id],
  );
  const amountCents = Number(sumRows[0]?.amount ?? 0);
  if (amountCents <= 0) {
    await dbQuery(
      `UPDATE payout_requests SET status = 'rejected', admin_note = COALESCE(admin_note, 'nothing_to_pay'),
              resolved_at = now(), resolved_by = 'system' WHERE id = $1`,
      [pr.id],
    );
    return { ok: false, code: "nothing_to_pay" };
  }

  const setup = await getSellerPayoutSetup(pr.seller_id);
  let transferId: string | null = null;
  if (setup.method === "stripe" && setup.accountId) {
    try {
      const transfer = await getStripe().transfers.create(
        { amount: amountCents, currency: setup.currency.toLowerCase(), destination: setup.accountId, metadata: { type: "seller_payout", payout_id: pr.id } },
        { idempotencyKey: `seller_payout:${pr.id}` },
      );
      transferId = transfer.id;
    } catch (err) {
      logger.error({ err, payoutId: pr.id }, "seller.payout.transfer_failed");
      await dbQuery(`UPDATE payout_requests SET status = 'pending', failure_reason = $2 WHERE id = $1`, [
        pr.id,
        String((err as Error)?.message ?? "transfer_failed").slice(0, 300),
      ]);
      return { ok: false, code: "transfer_failed" };
    }
  }

  await withTransaction(async (q) => {
    await q(
      `UPDATE commerce_order_items
          SET metadata = metadata || jsonb_build_object(
                'seller_payout_status', 'paid', 'seller_payout_paid_at', NOW()::text,
                'seller_payout_transfer_id', $2::text, 'seller_payout_method', $3::text)
        WHERE metadata->>'seller_payout_request_id' = $1 AND metadata->>'seller_payout_status' = 'requested'`,
      [pr.id, transferId, transferId ? "stripe" : "bank"],
    );
    await q(
      `UPDATE payout_requests
          SET status = 'paid', amount_cents = $3, paid_at = now(), resolved_at = now(), resolved_by = 'admin',
              stripe_transfer_id = $2, failure_reason = NULL
        WHERE id = $1`,
      [pr.id, transferId, amountCents],
    );
  });
  logger.info({ payoutId: pr.id, amountCents, via: transferId ? "stripe" : "bank" }, "seller.payout.paid");
  return { ok: true, status: "paid", via: transferId ? "stripe" : "bank", amountCents };
}
