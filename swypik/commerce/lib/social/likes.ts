/**
 * Like/unlike idempotent pe video și comentarii.
 *
 * `setLike(..., true)` de două ori = un singur rând; `setLike(..., false)` pe
 * ceva neapreciat = no-op. Contoarele (`videos.like_count`,
 * `comments.like_count`) sunt ținute EXCLUSIV de triggerul
 * `trg_likes_social_counter` (migrarea 20260926_0110) — aici doar le citim
 * după mutație, deci răspunsul e mereu valoarea reală din DB.
 */
import { dbQuery } from "@/lib/db";
import { isVideoInteractable } from "@/lib/video/interactable";
import { isBlockedEitherWay } from "./blocks";

export type LikeTarget = "video" | "comment";

export type LikeResult = {
  liked: boolean;
  /** true dacă starea chiar s-a schimbat (rând inserat/șters). */
  changed: boolean;
  likeCount: number;
};

export class LikeTargetUnavailable extends Error {
  constructor(readonly code: "video_not_available" | "comment_not_found" | "blocked") {
    super(code);
    this.name = "LikeTargetUnavailable";
  }
}

const COLUMN: Record<LikeTarget, "video_id" | "comment_id"> = { video: "video_id", comment: "comment_id" };
const TABLE: Record<LikeTarget, "videos" | "comments"> = { video: "videos", comment: "comments" };

export async function hasLiked(userId: string | null, target: LikeTarget, targetId: string): Promise<boolean> {
  if (!userId) return false;
  const { rows } = await dbQuery(
    `SELECT 1 FROM likes WHERE user_id = $1 AND ${COLUMN[target]} = $2 LIMIT 1`,
    [userId, targetId],
  );
  return rows.length > 0;
}

export async function readLikeCount(target: LikeTarget, targetId: string): Promise<number | null> {
  const { rows } = await dbQuery<{ like_count: string | number }>(
    `SELECT like_count FROM ${TABLE[target]} WHERE id = $1`,
    [targetId],
  );
  if (!rows[0]) return null;
  return Math.max(0, Number(rows[0].like_count) || 0);
}

/** Un like NOU se acceptă doar pe conținut vizibil, și nu între utilizatori care se blochează. */
async function assertLikeable(userId: string, target: LikeTarget, targetId: string): Promise<void> {
  if (target === "video") {
    if (!(await isVideoInteractable(targetId))) throw new LikeTargetUnavailable("video_not_available");
    return;
  }
  const { rows } = await dbQuery<{ user_id: string | null; video_id: string }>(
    `SELECT user_id, video_id FROM comments WHERE id = $1 AND status = 'visible'`,
    [targetId],
  );
  const comment = rows[0];
  if (!comment || !(await isVideoInteractable(comment.video_id))) {
    throw new LikeTargetUnavailable("comment_not_found");
  }
  if (comment.user_id && (await isBlockedEitherWay(userId, comment.user_id))) {
    throw new LikeTargetUnavailable("blocked");
  }
}

export async function setLike(
  userId: string,
  target: LikeTarget,
  targetId: string,
  liked: boolean,
): Promise<LikeResult> {
  const col = COLUMN[target];
  let changed: boolean;
  if (liked) {
    await assertLikeable(userId, target, targetId);
    const res = await dbQuery(
      `INSERT INTO likes (user_id, ${col}) VALUES ($1, $2)
       ON CONFLICT (user_id, ${col}) WHERE ${col} IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, targetId],
    );
    changed = res.rows.length > 0;
  } else {
    // Retragerea e mereu permisă (chiar dacă între timp clipul a devenit privat).
    const res = await dbQuery(`DELETE FROM likes WHERE user_id = $1 AND ${col} = $2 RETURNING id`, [
      userId,
      targetId,
    ]);
    changed = res.rows.length > 0;
  }
  const likeCount = (await readLikeCount(target, targetId)) ?? 0;
  return { liked, changed, likeCount };
}

/** Compatibilitate pentru clienții vechi (POST fără corp = comutare). */
export async function toggleLike(userId: string, target: LikeTarget, targetId: string): Promise<LikeResult> {
  const current = await hasLiked(userId, target, targetId);
  return setLike(userId, target, targetId, !current);
}
