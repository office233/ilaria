/**
 * Grilele de pe profil, cu cursor:
 *  - "videos": clipurile publice ale creatorului;
 *  - "liked":  clipurile apreciate (vizibile altora doar dacă users.liked_videos_public);
 *  - "saved":  clipurile salvate (doar proprietarul profilului).
 * Permisiunile se decid în `canViewTab`; interogările nu le mai verifică.
 */
import { dbQuery } from "@/lib/db";
import { decodeCursor, nextCursorFrom } from "../cursor";
import { PUBLIC_VIDEO_SQL } from "./stats";

export type ProfileTab = "videos" | "liked" | "saved";
export const PROFILE_TABS: readonly ProfileTab[] = ["videos", "liked", "saved"];

export type ProfileVideo = {
  id: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  viewCount: number;
  likeCount: number;
};

export type ProfileVideoPage = { items: ProfileVideo[]; nextCursor: string | null };

export function canViewTab(
  tab: ProfileTab,
  opts: { isOwner: boolean; likedVideosPublic: boolean },
): boolean {
  if (tab === "videos") return true;
  if (tab === "saved") return opts.isOwner;
  return opts.isOwner || opts.likedVideosPublic;
}

type Row = {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  duration_ms: number | string | null;
  view_count: number | string | null;
  like_count: number | string | null;
  sort_at: string;
};

const QUERIES: Record<ProfileTab, string> = {
  videos: `SELECT v.id, v.title, v.thumbnail_url, v.duration_ms, v.view_count, v.like_count,
                  COALESCE(v.published_at, v.created_at) AS sort_at
             FROM videos v
            WHERE v.creator_id = $1 AND ${PUBLIC_VIDEO_SQL} /*CURSOR:COALESCE(v.published_at, v.created_at)|v.id*/
            ORDER BY sort_at DESC, v.id DESC
            LIMIT $2`,
  liked: `SELECT v.id, v.title, v.thumbnail_url, v.duration_ms, v.view_count, v.like_count,
                 l.created_at AS sort_at
            FROM likes l
            JOIN videos v ON v.id = l.video_id
           WHERE l.user_id = $1 AND l.video_id IS NOT NULL AND ${PUBLIC_VIDEO_SQL} /*CURSOR:l.created_at|v.id*/
           ORDER BY sort_at DESC, v.id DESC
           LIMIT $2`,
  // O salvare poate exista în mai multe colecții — un clip apare o singură dată.
  saved: `SELECT * FROM (
            SELECT DISTINCT ON (v.id) v.id, v.title, v.thumbnail_url, v.duration_ms, v.view_count, v.like_count,
                   s.created_at AS sort_at
              FROM saves s
              JOIN videos v ON v.id = s.video_id
             WHERE s.user_id = $1 AND v.status = 'ready'
               AND (v.creator_id = $1 OR (${PUBLIC_VIDEO_SQL.replace("v.visibility = 'public'", "v.visibility IN ('public', 'unlisted')")}))
             ORDER BY v.id, s.created_at DESC
          ) sv
          WHERE true /*CURSOR:sv.sort_at|sv.id*/
          ORDER BY sort_at DESC, id DESC
          LIMIT $2`,
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Înlocuiește marcajul de cursor cu condiția keyset (sau nimic pe prima pagină). */
function applyCursor(sql: string, hasCursor: boolean): string {
  return sql.replace(/\/\*CURSOR:([^|]+)\|([^*]+)\*\//, (_m, at: string, id: string) =>
    hasCursor ? `AND (${at}, ${id}) < ($3::timestamptz, $4::uuid)` : "",
  );
}

export async function listProfileVideos(
  tab: ProfileTab,
  ownerId: string,
  opts: { cursor: string | null; limit: number },
): Promise<ProfileVideoPage> {
  const cursor = decodeCursor(opts.cursor);
  const params: unknown[] = [ownerId, opts.limit + 1];
  if (cursor) params.push(cursor.at, cursor.id);
  const { rows } = await dbQuery<Row>(applyCursor(QUERIES[tab], Boolean(cursor)), params);
  const page = nextCursorFrom(rows, opts.limit, (r) => r.sort_at);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      id: r.id,
      title: r.title || null,
      thumbnailUrl: r.thumbnail_url || null,
      durationMs: r.duration_ms === null ? null : num(r.duration_ms),
      viewCount: num(r.view_count),
      likeCount: num(r.like_count),
    })),
  };
}
