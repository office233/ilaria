/**
 * Statisticile unui profil — SURSA UNICĂ pentru /u/<username>, /account și
 * API-uri (nu mai există cifre hardcodate „0"). Toate cifrele privesc doar
 * clipurile vizibile public (aceleași filtre ca grila de pe profil); like-urile
 * și comentariile sunt contoarele ținute de triggere (20260926_0110).
 */
import { dbQuery } from "@/lib/db";

export type ProfileStats = {
  videos: number;
  followers: number;
  following: number;
  /** Aprecieri primite pe clipurile publice. */
  likes: number;
  views: number;
  comments: number;
};

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;

/** Filtrul „clip public vizibil" — refolosit de grilă și de statistici. */
export const PUBLIC_VIDEO_SQL = `v.status = 'ready'
  AND v.visibility = 'public'
  AND COALESCE(v.is_hidden, false) = false
  AND v.effective_label = 'safe'`;

type StatsRow = {
  videos: string | number | null;
  followers: string | number | null;
  following: string | number | null;
  likes: string | number | null;
  views: string | number | null;
  comments: string | number | null;
};

function n(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

export async function getProfileStats(userId: string, query: Query = dbQuery as Query): Promise<ProfileStats> {
  const { rows } = await query<StatsRow>(
    `SELECT
       (SELECT COUNT(*) FROM follows f WHERE f.following_user_id = $1) AS followers,
       (SELECT COUNT(*) FROM follows f WHERE f.follower_user_id = $1) AS following,
       agg.videos, agg.likes, agg.views, agg.comments
     FROM (
       SELECT COUNT(*) AS videos,
              COALESCE(SUM(v.like_count), 0) AS likes,
              COALESCE(SUM(v.view_count), 0) AS views,
              COALESCE(SUM(v.comment_count), 0) AS comments
         FROM videos v
        WHERE v.creator_id = $1 AND ${PUBLIC_VIDEO_SQL}
     ) agg`,
    [userId],
  );
  const row = rows[0];
  return {
    videos: n(row?.videos),
    followers: n(row?.followers),
    following: n(row?.following),
    likes: n(row?.likes),
    views: n(row?.views),
    comments: n(row?.comments),
  };
}
