/**
 * Comisioanele creatorilor — O SINGURĂ sursă de adevăr: portofelul RON
 * (wallet_ledger_entries, ref_type 'creator_commission').
 *
 * Când un item atribuit unui creator a trecut de fereastra de retur
 * (fulfilled + RETURN_WINDOW_DAYS, comanda nerambursată), cron-ul
 * process-payouts îl „maturează”: în aceeași tranzacție marchează
 * commerce_order_items.payout_status = 'paid' (cu rata snapshot în metadata)
 * și creditează comisionul în portofel. Retragerea banilor se face din
 * portofel (lib/creator/payouts.ts) — nu mai există transferuri per item
 * dependente de tabela veche creator_connect_accounts (mereu goală).
 *
 * Refund după maturare → reverseCreatorCommission* debitează comisionul
 * (soldul poate coborî sub zero; se compensează din câștigurile viitoare).
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { CREATOR_COMMISSION_BPS, applyBps } from "@/lib/config/commerce";
import { creditUserTx, debitUserTx } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";

/** Statusuri de item încă neplătite (inclusiv valorile istorice din fluxul Connect). */
export const UNPAID_ITEM_STATUSES = ["pending", "not_connected", "no_account", "failed"];
const BLOCKED_ORDER_STATUSES = ["refunded", "cancelled", "return_requested", "failed"];

export function creatorCommissionCents(commissionableCents: number, bps = CREATOR_COMMISSION_BPS): number {
  const base = Number(commissionableCents);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return applyBps(base, bps);
}

type Candidate = {
  item_id: string;
  order_id: string;
  creator_id: string;
  commissionable_cents: number;
  self_attributed: boolean;
};

export async function findMaturedCreatorItems(returnWindowDays: number, limit = 500): Promise<Candidate[]> {
  const { rows } = await dbQuery<Candidate>(
    `SELECT coi.id AS item_id, coi.order_id, coi.creator_id::text AS creator_id,
            coi.commissionable_amount_cents AS commissionable_cents,
            (s.user_id IS NOT NULL AND s.user_id = coi.creator_id) AS self_attributed
       FROM commerce_order_items coi
       JOIN users cu ON cu.id = coi.creator_id
       LEFT JOIN commerce_orders co ON co.id = coi.order_id
       LEFT JOIN sellers s ON s.id::text = coi.metadata->>'seller_id'
      WHERE coi.source_status = 'fulfilled'
        AND coi.updated_at < now() - make_interval(days => $1)
        AND coi.creator_id IS NOT NULL
        AND (coi.payout_status IS NULL OR coi.payout_status = ANY($2::text[]))
        AND coi.commissionable_amount_cents > 0
        AND (co.status IS NULL OR NOT (co.status = ANY($3::text[])))
        AND COALESCE((cu.metadata->'fraud_user_block'->>'blocked')::boolean, false) = false
      ORDER BY coi.updated_at ASC
      LIMIT $4`,
    [returnWindowDays, UNPAID_ITEM_STATUSES, BLOCKED_ORDER_STATUSES, limit],
  );
  return rows;
}

/**
 * Maturează comisioanele eligibile. Idempotent: claim atomic pe payout_status
 * + ledger idempotent pe (creator_commission, item_id).
 */
export async function accrueCreatorCommissions(returnWindowDays: number): Promise<{ accrued: number; blocked: number; skipped: number }> {
  const items = await findMaturedCreatorItems(returnWindowDays);
  let accrued = 0;
  let blocked = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      if (item.self_attributed) {
        // Sellerul care își atribuie propriul produs nu primește comision de creator.
        await dbQuery(
          `UPDATE commerce_order_items
              SET payout_status = 'restricted',
                  metadata = coalesce(metadata, '{}'::jsonb) || '{"creator_commission_blocked":"self_attribution"}'::jsonb
            WHERE id = $1 AND (payout_status IS NULL OR payout_status = ANY($2::text[]))`,
          [item.item_id, UNPAID_ITEM_STATUSES],
        );
        blocked++;
        continue;
      }
      const amount = creatorCommissionCents(item.commissionable_cents);
      const done = await withTransaction(async (q) => {
        const claim = await q(
          `UPDATE commerce_order_items
              SET payout_status = 'paid',
                  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                    'creator_commission_cents', $2::int,
                    'creator_commission_bps', $3::int,
                    'creator_commission_accrued_at', now()::text)
            WHERE id = $1 AND (payout_status IS NULL OR payout_status = ANY($4::text[]))
            RETURNING id`,
          [item.item_id, amount, CREATOR_COMMISSION_BPS, UNPAID_ITEM_STATUSES],
        );
        if (!claim.rowCount) return false;
        if (amount > 0) {
          await creditUserTx(q, {
            userId: item.creator_id,
            amountCents: amount,
            refType: "creator_commission",
            refId: item.item_id,
            description: "creator_commission",
            metadata: { orderId: item.order_id, bps: CREATOR_COMMISSION_BPS, base: item.commissionable_cents },
          });
        }
        return true;
      });
      if (done) accrued++;
      else skipped++;
    } catch (err) {
      skipped++;
      logger.error({ err, itemId: item.item_id }, "creator.commission.accrue_failed");
    }
  }
  return { accrued, blocked, skipped };
}

/**
 * Retrage comisioanele deja creditate pentru itemele date (refund după maturare)
 * și marchează restul itemelor neplătite ca 'refunded' (cron-ul le sare).
 */
export async function reverseCreatorCommissionsForItems(itemIds: string[], reason: string): Promise<number> {
  if (itemIds.length === 0) return 0;
  const { rows } = await dbQuery<{ id: string; creator_id: string; cents: string | null }>(
    `SELECT id, creator_id::text AS creator_id, metadata->>'creator_commission_cents' AS cents
       FROM commerce_order_items
      WHERE id = ANY($1::uuid[]) AND payout_status = 'paid' AND creator_id IS NOT NULL
        AND metadata ? 'creator_commission_cents'`,
    [itemIds],
  );
  let reversed = 0;
  for (const r of rows) {
    const cents = Number(r.cents ?? 0);
    await withTransaction(async (q) => {
      await q(
        `UPDATE commerce_order_items
            SET payout_status = 'refunded',
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('creator_commission_reversed_at', now()::text, 'creator_commission_reversal_reason', $2::text)
          WHERE id = $1 AND payout_status = 'paid'`,
        [r.id, reason],
      );
      if (cents > 0) {
        await debitUserTx(q, {
          userId: r.creator_id,
          amountCents: cents,
          refType: "creator_commission_reversal",
          refId: r.id,
          description: "creator_commission_reversal",
          metadata: { reason },
          allowNegative: true,
        });
      }
    }).then(() => reversed++, (err) => logger.error({ err, itemId: r.id }, "creator.commission.reverse_failed"));
  }
  return reversed;
}

/** Refund total venit prin webhook (charge.refunded) pentru o comandă plătită cu PaymentIntent. */
export async function reverseCreatorCommissionsForPaymentIntent(paymentIntentId: string, reason: string): Promise<number> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT coi.id FROM commerce_order_items coi
       JOIN commerce_orders co ON co.id = coi.order_id
      WHERE coi.creator_id IS NOT NULL
        AND (co.metadata->>'paymentIntentId' = $1
          OR co.metadata->>'payment_intent_id' = $1
          OR co.metadata->>'stripe_payment_intent' = $1)`,
    [paymentIntentId],
  );
  return reverseCreatorCommissionsForItems(rows.map((r) => r.id), reason);
}
