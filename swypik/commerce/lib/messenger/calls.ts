/**
 * Messenger call-session business logic — call creation, join, decline/end
 * signaling. Media runs on Cloudflare RealtimeKit (one meeting per call,
 * lib/realtime/rtk.ts); lifecycle updates from its signed webhooks live in
 * lib/messenger/call-webhook.ts. Kept separate from the route handlers so it can be
 * unit-tested with a mocked `@/lib/db`.
 *
 * Erorile poartă coduri stabile (message = cod), traduse în UI prin messenger.calls.errors.*.
 *
 * Authorization model:
 *   - A user may only start/join/decline/end a call that belongs to a
 *     conversation they are a participant of (conversation_participants).
 *   - Joining an existing "ringing" call only flips it to "accepted" when the
 *     caller is NOT the original caller_id (i.e. the callee is answering).
 *   - Ringing calls older than RINGING_TIMEOUT_SECONDS are lazily expired to
 *     "missed" whenever they're read (incoming poll, join, decline).
 */
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { assertParticipant } from "@/lib/dm/repository";

export const RINGING_TIMEOUT_SECONDS = 45;

export type CallType = "audio" | "video";

export class CallAuthError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "CallAuthError";
    this.status = status;
  }
}

export class CallNotFoundError extends Error {
  status = 404;
  constructor() {
    super("call_not_found");
    this.name = "CallNotFoundError";
  }
}

export type CallSessionRow = {
  id: string;
  conversation_id: string | null;
  caller_id: string;
  call_type: CallType;
  status: "initiating" | "ringing" | "accepted" | "rejected" | "missed" | "busy" | "ended" | "failed";
  livekit_room_name: string;
  rtk_meeting_id: string | null;
  started_at: string;
};

/** Expire ringing calls that have been unanswered for too long. Best-effort, idempotent. */
export async function expireStaleRingingCalls(): Promise<void> {
  await dbQuery(
    `UPDATE call_sessions
        SET status = 'missed', ended_at = COALESCE(ended_at, now())
      WHERE status = 'ringing'
        AND started_at < now() - interval '${RINGING_TIMEOUT_SECONDS} seconds'`,
  );
}

async function getCall(callId: string): Promise<CallSessionRow | null> {
  const { rows } = await dbQuery<CallSessionRow>(
    `SELECT id, conversation_id, caller_id, call_type, status, livekit_room_name, rtk_meeting_id, started_at
       FROM call_sessions WHERE id = $1 LIMIT 1`,
    [callId],
  );
  return rows[0] ?? null;
}

async function assertCallParticipant(call: CallSessionRow, userId: string): Promise<void> {
  if (call.caller_id === userId) return;
  if (!call.conversation_id) {
    throw new CallAuthError("not_participant", 403);
  }
  const ok = await assertParticipant(call.conversation_id, userId);
  if (!ok) throw new CallAuthError("not_participant", 403);
}

/**
 * Checks the caller may start a call in this conversation and returns a fresh
 * unique room key (also used as the RealtimeKit meeting title). Nothing is
 * written yet: the row is only inserted once the media provider succeeded.
 */
export async function prepareCall(callerId: string, conversationId: string): Promise<{ roomName: string }> {
  const ok = await assertParticipant(conversationId, callerId);
  if (!ok) throw new CallAuthError("not_participant", 403);
  return { roomName: `swypik_call_${crypto.randomUUID()}` };
}

/** Persist a brand-new ringing call bound to its RealtimeKit meeting. */
export async function createCall(
  callerId: string,
  conversationId: string,
  callType: CallType,
  media: { roomName: string; meetingId: string },
): Promise<{ callId: string }> {
  const ok = await assertParticipant(conversationId, callerId);
  if (!ok) throw new CallAuthError("not_participant", 403);

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO call_sessions (conversation_id, caller_id, call_type, status, livekit_room_name, provider, rtk_meeting_id)
     VALUES ($1, $2, $3, 'ringing', $4, 'cf_rtk', $5)
     RETURNING id`,
    [conversationId, callerId, callType, media.roomName, media.meetingId],
  );
  return { callId: rows[0].id };
}

/** Join an existing call (accept as callee, or the caller re-joining their own room). */
export async function joinCall(
  userId: string,
  callId: string,
): Promise<{ meetingId: string; callType: CallType }> {
  await expireStaleRingingCalls();

  const call = await getCall(callId);
  if (!call) throw new CallNotFoundError();
  await assertCallParticipant(call, userId);

  // No tokens for calls that are over (ended/declined/missed/failed/busy).
  if (!["initiating", "ringing", "accepted"].includes(call.status)) {
    throw new CallAuthError("call_inactive", 410);
  }
  // Legacy LiveKit calls have no RealtimeKit meeting to join.
  if (!call.rtk_meeting_id) throw new CallAuthError("call_inactive", 410);

  if (call.status === "ringing" && call.caller_id !== userId) {
    await dbQuery(
      `UPDATE call_sessions
          SET status = 'accepted', answered_at = COALESCE(answered_at, now())
        WHERE id = $1 AND status = 'ringing'`,
      [callId],
    );
  }

  return { meetingId: call.rtk_meeting_id, callType: call.call_type };
}

/** Decline a ringing call. Only a non-caller participant may decline. Returns the call (meeting to close). */
export async function declineCall(userId: string, callId: string): Promise<CallSessionRow> {
  const call = await getCall(callId);
  if (!call) throw new CallNotFoundError();
  await assertCallParticipant(call, userId);
  if (call.caller_id === userId) {
    throw new CallAuthError("caller_cannot_decline", 400);
  }
  await dbQuery(
    `UPDATE call_sessions
        SET status = 'rejected', ended_at = COALESCE(ended_at, now())
      WHERE id = $1 AND status IN ('ringing', 'initiating')`,
    [callId],
  );
  return call;
}

/** End an active/ringing call. Any participant may end it. Returns the call (meeting to close). */
export async function endCall(userId: string, callId: string): Promise<CallSessionRow> {
  const call = await getCall(callId);
  if (!call) throw new CallNotFoundError();
  await assertCallParticipant(call, userId);
  await dbQuery(
    `UPDATE call_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, now())
      WHERE id = $1 AND status NOT IN ('ended', 'rejected', 'missed', 'failed')`,
    [callId],
  );
  return call;
}

export type IncomingCall = {
  id: string;
  conversation_id: string;
  call_type: CallType;
  started_at: string;
  caller: { id: string; username: string | null; display_name: string | null; avatar_url: string | null };
};

/** Ringing calls the user should be alerted about (polled every ~5s by the client). */
export async function listIncomingCalls(userId: string): Promise<IncomingCall[]> {
  await expireStaleRingingCalls();

  const { rows } = await dbQuery<{
    id: string;
    conversation_id: string;
    call_type: CallType;
    started_at: string;
    caller_id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
  }>(
    `SELECT cs.id, cs.conversation_id, cs.call_type, cs.started_at,
            u.id AS caller_id, u.username, u.display_name, cpr.avatar_url
       FROM call_sessions cs
       JOIN conversation_participants cp
         ON cp.conversation_id = cs.conversation_id AND cp.user_id = $1
       JOIN users u ON u.id = cs.caller_id
       LEFT JOIN creator_profiles cpr ON cpr.user_id = u.id
      WHERE cs.status = 'ringing'
        AND cs.caller_id <> $1
      ORDER BY cs.started_at DESC
      LIMIT 5`,
    [userId],
  );

  return rows.map((r) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    call_type: r.call_type,
    started_at: r.started_at,
    caller: {
      id: r.caller_id,
      username: r.username,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
    },
  }));
}
