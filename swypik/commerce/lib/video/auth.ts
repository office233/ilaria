/**
 * Cine poate urca și gestiona clipuri: creatori, selleri (firme cu cont de
 * vânzător) și admini. Folosit de toate rutele fluxului de upload, ca să nu
 * existe verificări de rol diferite între „creează sesiunea” și „publică”.
 */
import { getCreatorUserId, getUserRole } from "@/lib/creator/session";
import { dbQuery } from "@/lib/db";

export const VIDEO_AUTHOR_ROLES: ReadonlySet<string> = new Set(["creator", "seller", "admin"]);

export type VideoAuthor = { userId: string; role: string };

export type AuthorResult = { ok: true; author: VideoAuthor } | { ok: false; status: 401 | 403; error: string };

export async function requireVideoAuthor(): Promise<AuthorResult> {
  const userId = await getCreatorUserId();
  if (!userId) return { ok: false, status: 401, error: "unauthorized" };
  const role = await getUserRole(userId);
  if (!role || !VIDEO_AUTHOR_ROLES.has(role)) return { ok: false, status: 403, error: "creator_role_required" };
  return { ok: true, author: { userId, role } };
}

export type OwnedVideo = {
  id: string;
  creator_id: string;
  status: string;
  visibility: string;
  moderation_status: string;
  published_at: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  audio_track_id?: number | string | null;
};

/** Clipul, dacă aparține autorului (sau autorul e admin); altfel null. */
export async function loadOwnedVideo(videoId: string, author: VideoAuthor): Promise<OwnedVideo | null | "forbidden"> {
  const { rows } = await dbQuery<OwnedVideo>(
    `SELECT id, creator_id, status, visibility, moderation_status, published_at,
            title, description, tags, metadata, audio_track_id
       FROM videos WHERE id = $1 AND status <> 'deleted' LIMIT 1`,
    [videoId],
  );
  const video = rows[0];
  if (!video) return null;
  if (video.creator_id !== author.userId && author.role !== "admin") return "forbidden";
  return video;
}
