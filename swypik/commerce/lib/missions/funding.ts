/**
 * Finanțarea misiunilor (escrow în RON).
 *
 *   seller:   createMission → draft/unfunded → createFundingIntent (Stripe
 *             PaymentIntent, metadata.kind='mission_funding') → webhook
 *             markMissionFunded → active/funded.
 *   platform: createMission cu funding_source='platform' → active/funded direct
 *             (bugetul Swypik; creat doar din admin).
 *
 * La închidere, restul neplătit din escrow se returnează sellerului (refund
 * parțial Stripe pe PaymentIntent-ul de finanțare, idempotent).
 */
import { randomBytes } from "crypto";
import { dbQuery, withTransaction } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { logger } from "@/lib/logger";
import { canCloseMission, escrowRemainingCents, missionPoolCents, MISSION_CURRENCY } from "./config";
import { missionSlug, type MissionCreateInput } from "./schemas";

export type MissionOwner =
  | { kind: "seller"; sellerId: string; userId: string | null }
  | { kind: "platform"; userId: string | null };

export async function createMission(input: MissionCreateInput, owner: MissionOwner): Promise<{ id: string; slug: string }> {
  const slug = missionSlug(input.title, randomBytes(3).toString("hex"));
  const platform = owner.kind === "platform";
  const pool = missionPoolCents(input.prizeCents, input.maxWinners);
  const { rows } = await dbQuery<{ id: string; slug: string }>(
    `INSERT INTO creator_missions
       (slug, seller_id, product_id, title, brief, format_hint,
        prize_amount_minor, prize_currency, max_winners,
        status, funding_source, funding_status, funded_cents, funded_at,
        starts_at, ends_at, created_by_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RON', $8,
             $9, $10, $11, $12, CASE WHEN $10 = 'platform' THEN now() END,
             now(), CASE WHEN $10 = 'platform' THEN now() + make_interval(days => $13) END,
             $14, jsonb_build_object('duration_days', $13::int))
     RETURNING id, slug`,
    [
      slug,
      owner.kind === "seller" ? owner.sellerId : null,
      input.productId ?? null,
      input.title,
      input.brief,
      input.formatHint ?? null,
      input.prizeCents,
      input.maxWinners,
      platform ? "active" : "draft",
      owner.kind,
      platform ? "funded" : "unfunded",
      platform ? pool : 0,
      input.durationDays,
      owner.userId,
    ],
  );
  logger.info({ missionId: rows[0].id, owner: owner.kind, pool }, "mission.created");
  return rows[0];
}

export type FundingIntentResult =
  | { ok: true; clientSecret: string; amountCents: number }
  | { ok: false; code: "not_found" | "already_funded" | "invalid_pool" };

export async function createFundingIntent(missionId: string, sellerId: string): Promise<FundingIntentResult> {
  const { rows } = await dbQuery<{
    id: string;
    prize_amount_minor: number;
    max_winners: number | null;
    funding_status: string;
    status: string;
  }>(
    `SELECT id, prize_amount_minor, max_winners, funding_status, status
       FROM creator_missions
      WHERE id = $1 AND seller_id = $2 AND funding_source = 'seller'`,
    [missionId, sellerId],
  );
  const m = rows[0];
  if (!m || m.status !== "draft") return { ok: false, code: "not_found" };
  if (m.funding_status === "funded" || m.funding_status === "refunded") return { ok: false, code: "already_funded" };
  const amount = missionPoolCents(Number(m.prize_amount_minor), Number(m.max_winners ?? 0));
  if (amount <= 0) return { ok: false, code: "invalid_pool" };

  const intent = await getStripe().paymentIntents.create(
    {
      amount,
      currency: MISSION_CURRENCY.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { kind: "mission_funding", mission_id: missionId, seller_id: sellerId },
    },
    { idempotencyKey: `mission_funding:${missionId}:${amount}` },
  );
  await dbQuery(
    `UPDATE creator_missions
        SET funding_status = 'pending', funding_payment_intent_id = $2
      WHERE id = $1 AND funding_status IN ('unfunded', 'pending')`,
    [missionId, intent.id],
  );
  if (!intent.client_secret) throw new Error("stripe_intent_missing_client_secret");
  return { ok: true, clientSecret: intent.client_secret, amountCents: amount };
}

/**
 * Webhook `payment_intent.succeeded` cu metadata.kind='mission_funding'.
 * Idempotent: doar rândurile încă nefinanțate trec în 'funded'. Suma încasată
 * trebuie să acopere fondul (premiu × câștigători), altfel misiunea NU se
 * activează (alertă în log, verificare manuală).
 */
export async function markMissionFunded(args: {
  paymentIntentId: string;
  missionId: string | null;
  amountReceivedCents: number;
  currency: string;
}): Promise<"funded" | "noop" | "underpaid" | "refunded_closed"> {
  const { paymentIntentId, missionId, amountReceivedCents, currency } = args;
  const { rows } = await dbQuery<{ id: string; prize_amount_minor: number; max_winners: number | null; status: string }>(
    `SELECT id, prize_amount_minor, max_winners, status FROM creator_missions
      WHERE (funding_payment_intent_id = $1 OR id::text = $2)
        AND funding_status IN ('unfunded', 'pending')
      LIMIT 1`,
    [paymentIntentId, missionId ?? ""],
  );
  const m = rows[0];
  if (!m) return "noop";
  if (m.status === "closed" || m.status === "archived") {
    // Plata a ajuns după ce misiunea a fost închisă: banii se întorc integral.
    await getStripe().refunds.create(
      { payment_intent: paymentIntentId, metadata: { kind: "mission_refund", mission_id: m.id } },
      { idempotencyKey: `mission_refund_closed:${m.id}` },
    );
    await dbQuery(
      `UPDATE creator_missions
          SET funding_status = 'refunded', funded_cents = $2, refunded_cents = $2,
              funded_at = now(), funding_payment_intent_id = $3
        WHERE id = $1 AND funding_status IN ('unfunded', 'pending')`,
      [m.id, amountReceivedCents, paymentIntentId],
    );
    logger.warn({ missionId: m.id, paymentIntentId }, "mission.funding.refunded_after_close");
    return "refunded_closed";
  }
  const pool = missionPoolCents(Number(m.prize_amount_minor), Number(m.max_winners ?? 0));
  if (currency.toLowerCase() !== "ron" || amountReceivedCents < pool) {
    logger.error({ missionId: m.id, paymentIntentId, amountReceivedCents, pool, currency }, "mission.funding.underpaid");
    return "underpaid";
  }
  const { rowCount } = await dbQuery(
    `UPDATE creator_missions
        SET funding_status = 'funded', funded_cents = $2, funded_at = now(),
            funding_payment_intent_id = $3, status = 'active', starts_at = now(),
            ends_at = now() + make_interval(days => COALESCE((metadata->>'duration_days')::int, 14))
      WHERE id = $1 AND funding_status IN ('unfunded', 'pending') AND status = 'draft'`,
    [m.id, amountReceivedCents, paymentIntentId],
  );
  if (!rowCount) return "noop";
  logger.info({ missionId: m.id, amountReceivedCents }, "mission.funding.funded");
  return "funded";
}

export type CloseResult =
  | { ok: true; refundedCents: number }
  | { ok: false; code: "not_found" | "unpaid_winners" | "already_closed" };

type CloseRow = {
  id: string;
  status: string;
  funding_source: string;
  funding_payment_intent_id: string | null;
  funded_cents: string;
  paid_out_cents: string;
  refunded_cents: string;
  unpaid_winners: number;
};

/**
 * Închide misiunea (nu mai primește clipuri) și eliberează restul din escrow:
 * refund Stripe pentru misiunile finanțate de seller, simplă eliberare pentru
 * cele de platformă. Refuzat cât timp există câștigători neplătiți.
 *
 * Totul într-o tranzacție cu misiunea blocată (`FOR UPDATE`) — aceeași blocare
 * pe care o ia plata unui câștigător (lib/missions/judging.ts). Ordinea:
 * blocare → validare stare → UPDATE closed + refunded_cents → refund Stripe.
 * Dacă Stripe eșuează, tranzacția se anulează (misiunea rămâne deschisă);
 * o plată de câștigător care aștepta blocarea vede apoi misiunea închisă și
 * escrow-ul golit, deci nu mai poate plăti din banii returnați.
 */
export async function closeMission(missionId: string, scope: { sellerId?: string }): Promise<CloseResult> {
  const result = await withTransaction(async (q): Promise<CloseResult> => {
    const { rows } = await q<CloseRow>(
      `SELECT m.id, m.status, m.funding_source, m.funding_payment_intent_id,
              m.funded_cents::text, m.paid_out_cents::text, m.refunded_cents::text,
              (SELECT COUNT(*)::int FROM creator_mission_submissions s
                WHERE s.mission_id = m.id AND s.status = 'winner') AS unpaid_winners
         FROM creator_missions m
        WHERE m.id = $1 AND ($2::uuid IS NULL OR m.seller_id = $2::uuid)
        FOR UPDATE OF m`,
      [missionId, scope.sellerId ?? null],
    );
    const m = rows[0];
    if (!m) return { ok: false, code: "not_found" };
    if (!canCloseMission(m.status)) return { ok: false, code: "already_closed" };
    if (m.unpaid_winners > 0) return { ok: false, code: "unpaid_winners" };

    const remaining = escrowRemainingCents(m);
    await q(
      `UPDATE creator_missions
          SET status = 'closed', closed_at = now(),
              refunded_cents = refunded_cents + $2,
              funding_status = CASE WHEN funding_status = 'funded' AND paid_out_cents = 0 AND $2 > 0
                                    THEN 'refunded' ELSE funding_status END
        WHERE id = $1 AND status IN ('draft', 'active')`,
      [m.id, remaining],
    );
    if (remaining > 0 && m.funding_source === "seller" && m.funding_payment_intent_id) {
      await getStripe().refunds.create(
        { payment_intent: m.funding_payment_intent_id, amount: remaining, metadata: { kind: "mission_refund", mission_id: m.id } },
        { idempotencyKey: `mission_refund:${m.id}:${remaining}` },
      );
    }
    return { ok: true, refundedCents: remaining };
  });
  if (result.ok) logger.info({ missionId, refundedCents: result.refundedCents }, "mission.closed");
  return result;
}

/**
 * Cron `missions-expire`: închide misiunile active expirate (ends_at + grația
 * de jurizare) care nu mai au câștigători neplătiți — escrow-ul rămas se
 * returnează sellerului prin {@link closeMission}. Întoarce câte s-au închis.
 */
export async function closeExpiredMissions(opts: { graceDays: number; limit: number }): Promise<{ closed: number; failed: number }> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT m.id FROM creator_missions m
      WHERE m.status = 'active' AND m.ends_at IS NOT NULL
        AND m.ends_at < now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM creator_mission_submissions s
                         WHERE s.mission_id = m.id AND s.status = 'winner')
      ORDER BY m.ends_at ASC
      LIMIT $2`,
    [opts.graceDays, opts.limit],
  );
  let closed = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const res = await closeMission(r.id, {});
      if (res.ok) closed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, missionId: r.id }, "mission.expire.close_failed");
    }
  }
  return { closed, failed };
}
