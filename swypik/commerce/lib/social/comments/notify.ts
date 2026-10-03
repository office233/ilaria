/**
 * Notificările declanșate de un comentariu nou: proprietarul clipului
 * („comment"), autorul comentariului la care se răspunde („reply") și
 * utilizatorii @menționați („mention"). Fiecare destinatar primește o singură
 * notificare; actorii anonimi nu notifică pe nimeni (lib/notifications/social).
 */
import { notifySocial, type SocialActor } from "@/lib/notifications/social";
import { filterUnblocked } from "../blocks";
import { SOCIAL_LIMITS } from "../config";
import { extractMentions, resolveMentionedUsers } from "./mentions";

export type CommentNotifyInput = {
  actor: SocialActor;
  videoId: string;
  commentId: string;
  text: string;
  videoOwnerId: string | null;
  parentAuthorId: string | null;
};

/** Destinatarii, în ordinea priorității; exportat pentru teste. */
export function planCommentNotifications(
  input: Pick<CommentNotifyInput, "actor" | "videoOwnerId" | "parentAuthorId">,
  mentionedIds: string[],
): { recipientId: string; notice: "comment" | "reply" | "mention" }[] {
  if (input.actor.isAnon) return [];
  const seen = new Set<string>([input.actor.userId]);
  const plan: { recipientId: string; notice: "comment" | "reply" | "mention" }[] = [];
  const add = (id: string | null, notice: "comment" | "reply" | "mention") => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    plan.push({ recipientId: id, notice });
  };
  add(input.parentAuthorId, "reply");
  add(input.videoOwnerId, "comment");
  for (const id of mentionedIds) add(id, "mention");
  return plan;
}

export async function notifyForComment(input: CommentNotifyInput): Promise<void> {
  if (input.actor.isAnon) return;
  const usernames = extractMentions(input.text, SOCIAL_LIMITS.mentionsPerComment);
  const mentioned = await resolveMentionedUsers(usernames);
  const allowed = await filterUnblocked(input.actor.userId, mentioned.map((m) => m.id));
  const plan = planCommentNotifications(input, allowed);
  await Promise.all(
    plan.map((p) =>
      notifySocial({
        recipientId: p.recipientId,
        actor: input.actor,
        notice: p.notice,
        videoId: input.videoId,
        commentId: input.commentId,
        preview: input.text,
      }),
    ),
  );
}
