/**
 * Loadere SQL pentru dashboard-ul creatorului (server only, parametrizate).
 * Câștigurile vin din `getCreatorEarnings` (portofelul RON), nu de aici.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type OverviewStats = {
  views30d: number;
  publishedVideos: number;
  newFollowers30d: number;
};

export type RecentVideo = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  status: string;
  visibility: string;
  isDraft: boolean;
  scheduledPublishAt: string | null;
  viewCount: number;
  createdAt: string;
};

export async function loadOverviewStats(userId: string): Promise<OverviewStats> {
  const [views, published, followers] = await Promise.all([
    dbQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM feed_events fe
         JOIN videos v ON v.id = fe.video_id
        WHERE v.creator_id = $1
          AND fe.event_type IN ('video_view', 'video_viewed')
          AND fe.occurred_at >= now() - interval '30 days'`,
      [userId],
    ),
    dbQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM videos
        WHERE creator_id = $1 AND status = 'ready' AND visibility = 'public' AND is_draft = false`,
      [userId],
    ),
    dbQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM follows
        WHERE following_user_id = $1 AND created_at >= now() - interval '30 days'`,
      [userId],
    ),
  ]);
  return {
    views30d: Number(views.rows[0]?.n ?? 0),
    publishedVideos: Number(published.rows[0]?.n ?? 0),
    newFollowers30d: Number(followers.rows[0]?.n ?? 0),
  };
}

export async function loadRecentVideos(userId: string, limit = 5): Promise<RecentVideo[]> {
  const { rows } = await dbQuery<{
    id: string;
    title: string;
    thumbnail_url: string | null;
    status: string;
    visibility: string;
    is_draft: boolean;
    scheduled_publish_at: string | null;
    view_count: string;
    created_at: string;
  }>(
    `SELECT id::text, title, thumbnail_url, status, visibility, is_draft,
            scheduled_publish_at::text, view_count::text, created_at::text
       FROM videos
      WHERE creator_id = $1 AND status <> 'deleted'
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    thumbnailUrl: r.thumbnail_url,
    status: r.status,
    visibility: r.visibility,
    isDraft: r.is_draft,
    scheduledPublishAt: r.scheduled_publish_at,
    viewCount: Number(r.view_count),
    createdAt: r.created_at,
  }));
}

/** Rulează un loader; la eroare loghează și întoarce `fallback` (pagina rămâne utilizabilă). */
export async function safeLoad<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, label }, "[creator/overview] loader failed");
    return fallback;
  }
}
