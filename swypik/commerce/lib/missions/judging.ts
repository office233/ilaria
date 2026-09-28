/**
 * Jurizarea misiunilor (admin sau sellerul care a finanțat misiunea).
 *
 *   winner → selectează câștigătorul ȘI plătește premiul, atomic:
 *            în aceeași tranzacție se blochează misiunea (FOR UPDATE), se
 *            verifică locurile și escrow-ul, se crește paid_out_cents, se
 *            marchează înscrierea 'paid' și se creditează portofelul RON al
 *            creatorului (ledger, ref 'mission_prize', idempotent).
 *   pay    → reîncearcă plata pentru rânduri vechi rămase 'winner'/'approved'.
 *   reject → respinge (nu se poate după plată).
 */
import { withTransaction, type TxQuery } from "@/lib/db";
import { creditUserTx } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";
import { notifyLocalized } from "@/lib/notifications/localized";
import { canPayMissionPrize, escrowRemainingCents, missionSelfDealingWindowDays } from "./config";
import type { JudgeAction } from "./schemas";

export type JudgeActor = { kind: "admin"; label: string } | { kind: "seller"; sellerId: string };

export type JudgeResult =
  | { ok: true; status: "paid" | "rejected"; prizeCents?: number }
  | {
      ok: false;
      code:
        | "not_found"
        | "invalid_transition"
        | "video_not_published"
        | "no_winner_slots"
        | "escrow_insufficient"
        | "mission_not_funded"
        | "mission_closed"
        | "self_dealing";
    };

type SubRow = {
  id: string;
  status: string;
  user_id: string;
  video_id: string | null;
  video_status: string | null;
  mission_id: string;
  mission_slug: string;
  mission_title: string;
  mission_status: string;
  seller_id: string | null;
  funding_status: string;
  prize_amount_minor: number;
  max_winners: number | null;
  funded_cents: string;
  paid_out_cents: string;
  refunded_cents: string;
};

async function loadLocked(q: TxQuery, submissionId: string, actor: JudgeActor): Promise<SubRow | null> {
  // Blocăm întâi misiunea (serializează plățile concurente pe același escrow),
  // apoi înscrierea.
  const { rows } = await q<SubRow>(
    `SELECT s.id, s.status, s.user_id, s.video_id, v.status AS video_status,
            m.id AS mission_id, m.slug AS mission_slug, m.title AS mission_title, m.status AS mission_status,
            m.seller_id, m.funding_status, m.prize_amount_minor, m.max_winners,
            m.funded_cents::text, m.paid_out_cents::text, m.refunded_cents::text
       FROM creator_mission_submissions s
       JOIN creator_missions m ON m.id = s.mission_id
       LEFT JOIN videos v ON v.id = s.video_id
      WHERE s.id = $1
      FOR UPDATE OF m, s`,
    [submissionId],
  );
  const row = rows[0];
  if (!row) return null;
  if (actor.kind === "seller" && row.seller_id !== actor.sellerId) return null;
  return row;
}

/**
 * Anti self-dealing: câștigătorul nu poate fi cel care finanțează misiunea sau
 * un cont legat de el. Legătură = același utilizator (creatorul misiunii,
 * user-ul/owner-ul sellerului), același email/telefon/cont Stripe ca sellerul,
 * sau sesiuni din ultimele N zile de pe același IP ori dispozitiv
 * (`MISSION_SELF_DEALING_WINDOW_DAYS`). Premiul e oricum reținut la retragere
 * (`MISSION_PRIZE_HOLD_DAYS`), deci cazurile ratate aici se pot opri manual.
 */
async function isRelatedToFunder(q: TxQuery, sub: SubRow): Promise<boolean> {
  const { rows } = await q<{ related: boolean }>(
    `WITH funder AS (
       SELECT u.id FROM creator_missions m
         LEFT JOIN sellers s ON s.id = m.seller_id
         CROSS JOIN LATERAL (VALUES (m.created_by_user_id), (s.user_id), (s.owner_user_id)) AS u(id)
        WHERE m.id = $2 AND u.id IS NOT NULL
     )
     SELECT (
       $1::uuid IN (SELECT id FROM funder)
       OR EXISTS (
         SELECT 1 FROM creator_missions m
           JOIN sellers s ON s.id = m.seller_id
           JOIN users w ON w.id = $1::uuid
          WHERE m.id = $2 AND (
               (w.email IS NOT NULL AND lower(w.email) = lower(s.email))
            OR (w.phone IS NOT NULL AND s.phone IS NOT NULL
                AND regexp_replace(w.phone, '\\D', '', 'g') = regexp_replace(s.phone, '\\D', '', 'g'))
            OR (w.stripe_connect_account_id IS NOT NULL AND w.stripe_connect_account_id = s.stripe_account_id)))
       OR EXISTS (
         SELECT 1 FROM user_sessions a
           JOIN user_sessions b
             ON (a.ip_address = b.ip_address OR a.device_fingerprint = b.device_fingerprint)
          WHERE a.user_id = $1::uuid
            AND b.user_id IN (SELECT id FROM funder) AND b.user_id <> $1::uuid
            AND a.created_at > now() - make_interval(days => $3)
            AND b.created_at > now() - make_interval(days => $3))
     ) AS related`,
    [sub.user_id, sub.mission_id, missionSelfDealingWindowDays()],
  );
  return Boolean(rows[0]?.related);
}

async function payInTx(q: TxQuery, sub: SubRow, judgedBy: string): Promise<JudgeResult> {
  if (!canPayMissionPrize(sub.mission_status)) return { ok: false, code: "mission_closed" };
  if (sub.funding_status !== "funded") return { ok: false, code: "mission_not_funded" };
  if (sub.video_status !== "ready") return { ok: false, code: "video_not_published" };
  if (await isRelatedToFunder(q, sub)) {
    logger.warn({ submissionId: sub.id, missionId: sub.mission_id }, "mission.submission.self_dealing_blocked");
    return { ok: false, code: "self_dealing" };
  }
  const prize = Number(sub.prize_amount_minor);
  if (escrowRemainingCents(sub) < prize) return { ok: false, code: "escrow_insufficient" };

  const { rows: cnt } = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM creator_mission_submissions
      WHERE mission_id = $1 AND status = 'paid'`,
    [sub.mission_id],
  );
  if (sub.max_winners !== null && Number(cnt[0]?.n ?? 0) >= sub.max_winners) {
    return { ok: false, code: "no_winner_slots" };
  }

  await q(
    `UPDATE creator_missions SET paid_out_cents = paid_out_cents + $2 WHERE id = $1`,
    [sub.mission_id, prize],
  );
  await q(
    `UPDATE creator_mission_submissions
        SET status = 'paid', paid_at = now(), payout_minor = $2, payout_currency = 'RON',
            judged_by = $3, judged_at = now()
      WHERE id = $1`,
    [sub.id, prize, judgedBy],
  );
  await creditUserTx(q, {
    userId: sub.user_id,
    amountCents: prize,
    refType: "mission_prize",
    refId: `mission:${sub.mission_id}:submission:${sub.id}`,
    description: `mission_prize:${sub.mission_slug}`,
    metadata: { missionId: sub.mission_id, submissionId: sub.id },
  });
  return { ok: true, status: "paid", prizeCents: prize };
}

export async function judgeSubmission(
  submissionId: string,
  action: JudgeAction,
  actor: JudgeActor,
): Promise<JudgeResult> {
  const judgedBy = actor.kind === "admin" ? `admin:${actor.label}` : `seller:${actor.sellerId}`;

  const outcome = await withTransaction(async (q) => {
    const sub = await loadLocked(q, submissionId, actor);
    if (!sub) return { result: { ok: false, code: "not_found" } as JudgeResult, sub: null };

    if (action.action === "reject") {
      if (!["submitted", "approved", "winner"].includes(sub.status)) {
        return { result: { ok: false, code: "invalid_transition" } as JudgeResult, sub };
      }
      await q(
        `UPDATE creator_mission_submissions
            SET status = 'rejected', rejection_reason = $2, judged_by = $3, judged_at = now()
          WHERE id = $1`,
        [sub.id, action.reason ?? null, judgedBy],
      );
      return { result: { ok: true, status: "rejected" } as JudgeResult, sub };
    }

    const payable = action.action === "winner" ? ["submitted", "approved", "winner"] : ["winner", "approved"];
    if (!payable.includes(sub.status)) {
      return { result: { ok: false, code: "invalid_transition" } as JudgeResult, sub };
    }
    return { result: await payInTx(q, sub, judgedBy), sub };
  });

  const { result, sub } = outcome;
  if (result.ok && sub) {
    logger.info({ submissionId, action: action.action, judgedBy }, "mission.submission.judged");
    const values = { mission: sub.mission_title, amount: (result.prizeCents ?? 0) / 100 };
    // Best effort: plata e deja comisă — o notificare eșuată nu transformă succesul în 500.
    try {
      await notifyLocalized(sub.user_id, result.status === "paid" ? "missionWinner" : "missionRejected", {
        url: result.status === "paid" ? "/creator/earnings" : `/missions/${sub.mission_slug}`,
        values,
      });
    } catch (err) {
      logger.warn({ err, submissionId }, "mission.submission.notify_failed");
    }
  }
  return result;
}

export function judgeErrorStatus(code: Exclude<JudgeResult, { ok: true }>["code"]): number {
  return code === "not_found" ? 404 : code === "video_not_published" ? 422 : 409;
}
