/**
 * Evenimentele RealtimeKit care conduc starea unui apel Messenger
 * (https://developers.cloudflare.com/realtime/realtimekit/webhooks/):
 *   meeting.participantJoined → call_participants.joined_at; callee intrat ⇒ ringing → accepted
 *   meeting.participantLeft   → call_participants.left_at
 *   meeting.ended             → accepted ⇒ ended, nerăspuns ⇒ missed (+ ended_at, end_reason;
 *                                durata o calculează trigger-ul trg_calc_call_duration)
 * Toate scrierile sunt condiționate de starea curentă ⇒ idempotente la reîncercări.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

export type RtkWebhookEvent = {
  event?: string;
  reason?: string;
  meeting?: { id?: string; startedAt?: string; endedAt?: string };
  participant?: { customParticipantId?: string; joinedAt?: string; leftAt?: string };
};

export type CallWebhookOutcome = "ignored" | "unknown_call" | "joined" | "left" | "ended" | "noop";

type CallRef = { id: string; caller_id: string };

async function findCall(meetingId: string): Promise<CallRef | null> {
  const { rows } = await dbQuery<CallRef>(
    `SELECT id, caller_id FROM call_sessions WHERE rtk_meeting_id = $1 LIMIT 1`,
    [meetingId],
  );
  return rows[0] ?? null;
}

/** ISO valid sau null (câmpurile vin de la terț; nu le trimitem nevalidate în SQL). */
function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

async function onJoined(call: CallRef, userId: string, at: string | null): Promise<CallWebhookOutcome> {
  await dbQuery(
    `INSERT INTO call_participants (call_id, user_id, status, joined_at)
     VALUES ($1, $2, 'accepted', COALESCE($3::timestamptz, now()))
     ON CONFLICT (call_id, user_id)
     DO UPDATE SET status = 'accepted', joined_at = COALESCE(call_participants.joined_at, EXCLUDED.joined_at), left_at = NULL`,
    [call.id, userId, at],
  );
  if (userId !== call.caller_id) {
    await dbQuery(
      `UPDATE call_sessions
          SET status = 'accepted', answered_at = COALESCE(answered_at, $2::timestamptz, now())
        WHERE id = $1 AND status IN ('initiating', 'ringing')`,
      [call.id, at],
    );
  }
  return "joined";
}

async function onLeft(call: CallRef, userId: string, at: string | null): Promise<CallWebhookOutcome> {
  await dbQuery(
    `UPDATE call_participants SET status = 'ended', left_at = COALESCE($3::timestamptz, now())
      WHERE call_id = $1 AND user_id = $2`,
    [call.id, userId, at],
  );
  return "left";
}

async function onEnded(call: CallRef, at: string | null, reason: string | null): Promise<CallWebhookOutcome> {
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE call_sessions
        SET status = (CASE WHEN answered_at IS NULL THEN 'missed' ELSE 'ended' END)::call_status_enum,
            ended_at = COALESCE(ended_at, $2::timestamptz, now()),
            end_reason = COALESCE(end_reason, $3)
      WHERE id = $1 AND status IN ('initiating', 'ringing', 'accepted')
      RETURNING id`,
    [call.id, at, reason],
  );
  return rows.length > 0 ? "ended" : "noop";
}

export async function handleRtkEvent(event: RtkWebhookEvent): Promise<CallWebhookOutcome> {
  const meetingId = event.meeting?.id;
  if (!meetingId) return "ignored";
  const call = await findCall(meetingId);
  if (!call) return "unknown_call";

  const userId = event.participant?.customParticipantId;
  switch (event.event) {
    case "meeting.participantJoined":
      return userId && isUuid(userId) ? onJoined(call, userId, isoOrNull(event.participant?.joinedAt)) : "noop";
    case "meeting.participantLeft":
      return userId && isUuid(userId) ? onLeft(call, userId, isoOrNull(event.participant?.leftAt)) : "noop";
    case "meeting.ended":
      return onEnded(call, isoOrNull(event.meeting?.endedAt), event.reason?.slice(0, 64) ?? null);
    default:
      logger.debug({ event: event.event, callId: call.id }, "[calls/webhook] unhandled event");
      return "noop";
  }
}

/**
 * Deduplicare după `rtk-uuid`: true = livrare nouă (de procesat). Fără id,
 * procesăm oricum — handler-ele sunt idempotente.
 */
export async function claimDelivery(deliveryId: string | null, event: string): Promise<boolean> {
  if (!deliveryId) return true;
  const { rows } = await dbQuery<{ delivery_id: string }>(
    `INSERT INTO realtime_webhook_deliveries (delivery_id, provider, event)
     VALUES ($1, 'cf_rtk', $2)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING delivery_id`,
    [deliveryId.slice(0, 200), event.slice(0, 100)],
  );
  return rows.length > 0;
}

/** Eliberează livrarea când procesarea a eșuat, ca reîncercarea să nu fie ignorată. */
export async function releaseDelivery(deliveryId: string | null): Promise<void> {
  if (!deliveryId) return;
  await dbQuery(`DELETE FROM realtime_webhook_deliveries WHERE delivery_id = $1`, [deliveryId.slice(0, 200)]);
}
