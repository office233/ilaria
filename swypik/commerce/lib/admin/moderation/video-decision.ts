/**
 * Decizia de moderare pe un clip: aprobare / respingere.
 * Folosită de consola de admin (/api/admin/moderation/videos/[id]).
 *
 * Acoperă ambele cozi:
 *   - „în așteptare”: videos.moderation_status = 'pending_review' (upload nou);
 *   - „semnalate”: cazuri deschise în moderation_cases pe clip (AI / rapoarte).
 *
 * Aprobare: moderation_status = 'approved' — decide DOAR vizibilitatea în feed
 * (trigger-ul din migrarea 20260926_0012 derivă effective_label). `visibility`
 * rămâne intenția creatorului: aprobarea NU publică draft-uri sau clipuri
 * programate. Cazurile deschise se închid fără acțiune.
 * Respingere: moderation_status = 'rejected' + ascuns; cazurile se închid cu 'hide'.
 */
import { withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifyLocalized } from "@/lib/notifications/localized";
import { notifyFollowersOnce } from "@/lib/video/publish-notify";

export type VideoDecision = "approve" | "reject";

export type VideoDecisionResult =
  | {
      ok: true;
      videoId: string;
      creatorId: string | null;
      title: string | null;
      /** Clipul era în așteptare și tocmai a fost aprobat. */
      published: boolean;
      casesClosed: number;
    }
  | { ok: false; error: "not_found" | "already_decided" };

type VideoRow = { id: string; creator_id: string | null; title: string | null; moderation_status: string };

export async function decideVideo(args: {
  videoId: string;
  decision: VideoDecision;
  reason: string | null;
  actorUserId: string | null;
}): Promise<VideoDecisionResult> {
  const { videoId, decision, reason, actorUserId } = args;
  const approve = decision === "approve";

  return withTransaction<VideoDecisionResult>(async (q) => {
    const { rows } = await q<VideoRow>(
      `SELECT id::text, creator_id::text, title, moderation_status
         FROM videos WHERE id = $1 AND COALESCE(status, '') <> 'deleted' FOR UPDATE`,
      [videoId],
    );
    const v = rows[0];
    if (!v) return { ok: false, error: "not_found" };

    const { rows: openCases } = await q<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM moderation_cases
        WHERE target_video_id = $1 AND status IN ('open', 'in_review')`,
      [videoId],
    );
    const pending = v.moderation_status === "pending_review";
    if (!pending && (openCases[0]?.c ?? 0) === 0) return { ok: false, error: "already_decided" };

    if (approve && pending) {
      await q(
        `UPDATE videos
            SET moderation_status = 'approved',
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('moderation_reason', $2::text),
                updated_at = now()
          WHERE id = $1`,
        [videoId, reason ?? ""],
      );
    } else if (!approve) {
      await q(
        `UPDATE videos
            SET moderation_status = 'rejected', is_hidden = true, hidden_at = COALESCE(hidden_at, now()),
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('moderation_reason', $2::text),
                updated_at = now()
          WHERE id = $1`,
        [videoId, reason ?? ""],
      );
      await q(
        `INSERT INTO moderation_actions (actor_user_id, target_video_id, action_type, reason)
         VALUES ($1, $2, 'hide', $3)`,
        [actorUserId, videoId, reason],
      );
    }

    const closed = await q(
      `UPDATE moderation_cases
          SET status = 'resolved', decision = $2, resolution_note = $3,
              resolved_by_user_id = $4, resolved_at = now(), updated_at = now()
        WHERE target_video_id = $1 AND status IN ('open', 'in_review')`,
      [videoId, approve ? "no_action" : "hide", reason, actorUserId],
    );

    return {
      ok: true,
      videoId: v.id,
      creatorId: v.creator_id,
      title: v.title,
      published: approve && pending,
      casesClosed: closed.rowCount ?? 0,
    };
  });
}

/** Efecte după commit (best-effort): anunț către urmăritori la publicare, notificare la respingere. */
export async function afterVideoDecision(
  result: Extract<VideoDecisionResult, { ok: true }>,
  decision: VideoDecision,
): Promise<void> {
  if (!result.creatorId) return;
  if (decision === "approve" && result.published) {
    // O singură dată per clip și doar dacă e deja public + procesat (altfel îl
    // anunță publicarea / cronul publish-scheduled).
    await notifyFollowersOnce(result.videoId).catch((err) =>
      logger.warn({ err, videoId: result.videoId }, "[moderation] new_post fan-out failed"),
    );
  } else if (decision === "reject") {
    await notifyLocalized(result.creatorId, "videoRejected", { url: "/creator" });
  }
}
