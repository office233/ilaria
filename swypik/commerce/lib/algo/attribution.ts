/**
 * Atribuire vânzare → clip + fond creator lunar (FRONT 3).
 *
 * - attributeOrder(orderId): la trecerea comenzii în 'paid' creează rânduri în
 *   video_attributions. Sursa primară: commerce_order_items.video_id (link
 *   direct). Fallback: fereastră de atribuire de 7 zile pe feed_events
 *   (ultimul video_view / product_click / add_to_cart al cumpărătorului
 *   pentru un clip al creatorului produsului).
 * - distributeCreatorFund(month, poolCents): distribuie pool-ul lunar
 *   proporțional cu watch-time-ul calificat (evenimente watch_time cu
 *   watch_ms >= fund_min_watch_ms). Payout prin creditUser() → wallet_ledger_entries
 *   (kind='coins', reason='creator_fund'), cu prag minim de retragere.
 */

import { dbQuery, withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { loadFeedWeights } from "@/lib/algo/scoring";
import { CREATOR_COMMISSION_BPS as CREATOR_COMMISSION_RATE_BPS } from "@/lib/config/commerce";
import { creditUserTx } from "@/lib/wallet/ledger";

const ATTRIBUTION_WINDOW_DAYS = 7;

type AttributionRow = {
  video_id: string;
  creator_id: string;
  commission_cents: number;
  source: "order_item" | "event_window";
};

/**
 * Idempotent (UNIQUE (video_id, order_id) + ON CONFLICT DO NOTHING).
 * Returnează numărul de atribuiri noi create.
 */
export async function attributeOrder(orderId: string): Promise<number> {
  const { rows: items } = await dbQuery<{
    video_id: string | null;
    creator_id: string | null;
    buyer_user_id: string | null;
    commissionable_cents: string | number | null;
    line_total: string | number;
  }>(
    `SELECT i.video_id, i.creator_id, o.buyer_user_id,
            i.commissionable_amount_cents AS commissionable_cents,
            (i.unit_amount_cents * i.quantity) AS line_total
       FROM commerce_order_items i
       JOIN commerce_orders o ON o.id = i.order_id
      WHERE i.order_id = $1`,
    [orderId]
  );
  if (items.length === 0) return 0;

  const buyerUserId = items[0]?.buyer_user_id ?? null;
  const byVideo = new Map<string, AttributionRow>();

  for (const item of items) {
    const base = Number(item.commissionable_cents ?? item.line_total) || 0;
    const commission = Math.floor((base * CREATOR_COMMISSION_RATE_BPS) / 10_000);
    if (item.video_id && item.creator_id) {
      const existing = byVideo.get(item.video_id);
      if (existing) {
        existing.commission_cents += commission;
      } else {
        byVideo.set(item.video_id, {
          video_id: item.video_id,
          creator_id: item.creator_id,
          commission_cents: commission,
          source: "order_item",
        });
      }
    }
  }

  // Fallback: fereastră de 7 zile pe feed_events pentru itemele fără video_id.
  if (byVideo.size === 0 && buyerUserId) {
    const { rows: eventRows } = await dbQuery<{
      video_id: string;
      creator_id: string;
    }>(
      `SELECT fe.video_id, v.creator_id
         FROM feed_events fe
         JOIN videos v ON v.id = fe.video_id
        WHERE fe.actor_user_id = $1
          AND fe.video_id IS NOT NULL
          AND fe.event_type IN ('video_view', 'product_click', 'add_to_cart')
          AND fe.occurred_at > NOW() - INTERVAL '${ATTRIBUTION_WINDOW_DAYS} days'
        ORDER BY fe.occurred_at DESC
        LIMIT 1`,
      [buyerUserId]
    );
    const hit = eventRows[0];
    if (hit) {
      const totalBase = items.reduce(
        (sum, i) => sum + (Number(i.commissionable_cents ?? i.line_total) || 0),
        0
      );
      byVideo.set(hit.video_id, {
        video_id: hit.video_id,
        creator_id: hit.creator_id,
        commission_cents: Math.floor(
          (totalBase * CREATOR_COMMISSION_RATE_BPS) / 10_000
        ),
        source: "event_window",
      });
    }
  }

  let created = 0;
  for (const attr of byVideo.values()) {
    const { rowCount } = await dbQuery(
      `INSERT INTO video_attributions
         (video_id, order_id, creator_id, buyer_user_id, commission_cents,
          attribution_source, window_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (video_id, order_id) DO NOTHING`,
      [
        attr.video_id,
        orderId,
        attr.creator_id,
        buyerUserId,
        attr.commission_cents,
        attr.source,
        ATTRIBUTION_WINDOW_DAYS,
      ]
    );
    created += rowCount ?? 0;
  }
  if (created > 0) {
    logger.info(
      { order_id: orderId, attributions: created },
      "[algo] video attributions created"
    );
  }
  return created;
}

/**
 * Distribuie fondul creator pentru o lună (YYYY-MM-01). Idempotent per lună.
 * Payout: 1 coin = 1 cent echivalent (coins sunt credit de platformă).
 */
export async function distributeCreatorFund(
  month: string,
  poolCents: number
): Promise<{ poolId: string; paid: number; belowThreshold: number }> {
  const weights = await loadFeedWeights();

  return withTransaction(async (q) => {
    const poolRes = await q<{ id: string; status: string }>(
      `INSERT INTO creator_fund_pools (month, pool_cents)
       VALUES ($1::date, $2)
       ON CONFLICT (month) DO UPDATE SET pool_cents = EXCLUDED.pool_cents
       RETURNING id, status`,
      [month, poolCents]
    );
    const pool = poolRes.rows[0];
    if (pool.status === "distributed") {
      return { poolId: pool.id, paid: 0, belowThreshold: 0 };
    }

    // Watch-time calificat per creator în luna respectivă.
    const wtRes = await q<{ creator_id: string; qualified_ms: string }>(
      `SELECT v.creator_id, SUM(fe.watch_ms)::bigint AS qualified_ms
         FROM feed_events fe
         JOIN videos v ON v.id = fe.video_id
        WHERE fe.event_type = 'watch_time'
          AND fe.watch_ms >= $1
          AND fe.occurred_at >= $2::date
          AND fe.occurred_at < ($2::date + INTERVAL '1 month')
        GROUP BY v.creator_id`,
      [weights.fund_min_watch_ms, month]
    );
    const creators = wtRes.rows;
    const totalMs = creators.reduce((s, c) => s + Number(c.qualified_ms), 0);

    let paid = 0;
    let belowThreshold = 0;

    for (const c of creators) {
      const ms = Number(c.qualified_ms);
      const ratio = totalMs > 0 ? ms / totalMs : 0;
      const amount = Math.floor(poolCents * ratio);
      const meetsThreshold = amount >= weights.fund_payout_min_cents;

      const payoutRes = await q<{ id: string }>(
        `INSERT INTO creator_fund_payouts
           (pool_id, creator_id, qualified_watch_ms, share_ratio, amount_cents,
            status, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'paid' THEN NOW() END)
         ON CONFLICT (pool_id, creator_id) DO NOTHING
         RETURNING id`,
        [
          pool.id,
          c.creator_id,
          ms,
          ratio,
          amount,
          meetsThreshold ? "paid" : "below_threshold",
        ]
      );
      if (payoutRes.rowCount === 0) continue; // deja procesat

      if (meetsThreshold && amount > 0) {
        // Bani reali (cenți) → ledger-ul financiar, idempotent pe payout id.
        // În ACEEAȘI tranzacție cu rândul de payout: dacă tranzacția externă
        // face rollback, nici creditul nu rămâne (înainte creditUser deschidea
        // propria tranzacție → dublă creditare la reluare).
        await creditUserTx(q, {
          userId: c.creator_id,
          amountCents: amount,
          refType: "creator_fund_payout",
          refId: payoutRes.rows[0].id,
          description: `Creator fund ${month}`,
          metadata: { month, qualified_watch_ms: ms },
        });
        paid += 1;
      } else {
        belowThreshold += 1;
      }
    }

    await q(
      `UPDATE creator_fund_pools
          SET status = 'distributed', distributed_at = NOW()
        WHERE id = $1`,
      [pool.id]
    );
    logger.info(
      { month, pool_cents: poolCents, paid, below_threshold: belowThreshold },
      "[algo] creator fund distributed"
    );
    return { poolId: pool.id, paid, belowThreshold };
  });
}
