/**
 * „Sună oriunde”: la un apel nou, fiecare destinatar primește
 *   1) un eveniment realtime pe `call:user:<id>` (Redis → orice replică) pe care
 *      îl ascultă SSE-ul /api/messenger/calls/stream (montat global în app);
 *   2) un Web Push (tradus în limba lui) — pentru app în fundal / tab închis.
 * Best effort: un eșec aici nu anulează apelul (clientul are și poll de rezervă).
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { publishRealtime } from "@/lib/realtime";
import { sendPushToUser } from "@/lib/push/web-push";
import { userLocale } from "@/lib/notifications/localized";
import type { CallType } from "./calls";

export const callUserChannel = (userId: string) => `call:user:${userId}`;

export type CallRingEvent =
  | { kind: "ring"; callId: string }
  | { kind: "stop"; callId: string };

async function calleeIds(conversationId: string, callerId: string): Promise<string[]> {
  const { rows } = await dbQuery<{ user_id: string }>(
    `SELECT user_id::text FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2`,
    [conversationId, callerId],
  );
  return rows.map((r) => r.user_id);
}

export async function ringCallees(args: {
  callId: string;
  conversationId: string;
  callerId: string;
  callerName: string;
  callType: CallType;
}): Promise<void> {
  try {
    const ids = await calleeIds(args.conversationId, args.callerId);
    await Promise.all(
      ids.map(async (uid) => {
        await publishRealtime(callUserChannel(uid), { kind: "ring", callId: args.callId } satisfies CallRingEvent).catch(() => false);
        const t = await getTranslations({ locale: await userLocale(uid), namespace: "messenger.incomingCall" });
        await sendPushToUser(uid, {
          title: t(args.callType === "video" ? "pushTitleVideo" : "pushTitleAudio", { name: args.callerName }),
          body: t("pushBody"),
          url: `/messages/${args.conversationId}`,
          tag: `call:${args.callId}`,
        }).catch(() => undefined);
      }),
    );
  } catch (err) {
    logger.warn({ err, callId: args.callId }, "[messenger] ring callees failed");
  }
}

/** Oprește soneria la ceilalți participanți (apel refuzat / încheiat / preluat). */
export async function stopRinging(callId: string, conversationId: string | null, exceptUserId: string): Promise<void> {
  if (!conversationId) return;
  try {
    const ids = await calleeIds(conversationId, exceptUserId);
    await Promise.all(ids.map((uid) => publishRealtime(callUserChannel(uid), { kind: "stop", callId } satisfies CallRingEvent).catch(() => false)));
  } catch (err) {
    logger.warn({ err, callId }, "[messenger] stop ringing failed");
  }
}
