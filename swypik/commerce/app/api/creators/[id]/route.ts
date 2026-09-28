/**
 * GENERATED-CONSUMER-NOTE
 * Public read-only profile endpoint consumed by external clients (mobile app,
 * Go platform-api). The website itself uses /u/[username] + lib/social/user-profile
 * server-side, so this route currently has no in-app fetch caller.
 */
import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

/**
 * GET /api/creators/[id]
 *
 * Public endpoint — returns creator profile + their public videos.
 *
 * Schema (migration 0001):
 *   users:            id, username, display_name, avatar_url, bio, metadata
 *   creator_profiles: id, user_id (FK→users), commission_rate_bps, status, verified_at
 *   videos:           creator_id (FK→users), status, visibility, view_count, like_count,
 *                     published_at, thumbnail_url, playback_url, title, duration_ms, product_refs
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: creatorId } = await params;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!creatorId || !UUID_RE.test(creatorId)) {
    return NextResponse.json({ error: "Invalid creator ID" }, { status: 400 });
  }

  try {
    // ── Query 1: Profile + aggregate stats ──────────────────────────
    const { rows: profileRows } = await dbQuery(
      `SELECT
         u.id,
         u.display_name,
         u.username,
         u.avatar_url,
         u.bio,
         cp.verification_status = 'verified' AS is_verified,
         (SELECT COUNT(*)
            FROM videos
           WHERE creator_id = u.id
             AND status     = 'ready'
             AND visibility = 'public'
               AND COALESCE(is_hidden, false) = false
               AND videos.effective_label = 'safe') AS video_count,
         (SELECT COALESCE(SUM(view_count), 0)
            FROM videos
           WHERE creator_id = u.id
               AND status     = 'ready'
               AND visibility = 'public'
               AND COALESCE(is_hidden, false) = false
               AND videos.effective_label = 'safe') AS total_views
       FROM users u
       LEFT JOIN creator_profiles cp ON cp.user_id = u.id
       WHERE u.id = $1`,
      [creatorId],
    );

    if (profileRows.length === 0) {
      return NextResponse.json(
        { error: "Creator not found" },
        { status: 404 },
      );
    }

    const profile = profileRows[0];

    // ── Query 2: Latest public clips ────────────────────────────────
    const { rows: videoRows } = await dbQuery(
      `SELECT
         id,
         title,
         thumbnail_url,
         playback_url,
         duration_ms,
         view_count,
         like_count,
         published_at
       FROM videos
       WHERE creator_id = $1
         AND status     = 'ready'
         AND visibility = 'public'
         AND COALESCE(is_hidden, false) = false
         AND effective_label = 'safe'
       ORDER BY published_at DESC
       LIMIT 30`,
      [creatorId],
    );

    return NextResponse.json({
      creator: {
        id:          profile.id,
        display_name: profile.display_name,
        username:    profile.username,
        avatar_url:  profile.avatar_url,
        bio:         profile.bio,
        is_verified: profile.is_verified,
        video_count: Number(profile.video_count),
        total_views: Number(profile.total_views),
      },
      videos: videoRows.map((v: any) => ({
        id:            v.id,
        title:         v.title,
        thumbnail_url: v.thumbnail_url,
        playback_url:  v.playback_url,
        duration_ms:   v.duration_ms,
        view_count:    v.view_count ?? 0,
        like_count:    v.like_count ?? 0,
        published_at:  v.published_at,
      })),
    });
  } catch (err: any) {
    logger.error({ err: err }, "GET /api/creators/[id] error:");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
