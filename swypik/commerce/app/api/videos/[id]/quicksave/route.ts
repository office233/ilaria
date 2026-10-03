import { NextRequest, NextResponse } from "next/server";
import { dbQuery, getDb } from "@/lib/db";
import { anonSessionErrorResponse, getOrCreateSocialUser, setAnonSessionCookie } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { isVideoInteractable } from "@/lib/video/interactable";

import { logger } from "@/lib/logger";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
export const dynamic = "force-dynamic";

/**
 * POST /api/videos/:id/quicksave
 *
 * One-tap save. Auto-decides which user_collection to use:
 *   1. The most recently used collection (by user_collection_items.created_at), OR
 *   2. The "Idei utile" default if no items yet, OR
 *   3. The first available default, OR
 *   4. Creates a "Idei utile" default on the fly.
 *
 * Body (optional): { collection_id?: string }
 *   If collection_id is provided and owned by the user, it is used directly.
 *
 * Response: { collection: {id, title, icon}, added: boolean }
 *
 * Note: legacy POST /api/videos/:id/save still exists and toggles the
 * separate `saves` table for backwards-compat with the original feed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getOrCreateSocialUser();
    const userId = session.userId;
    const { id: videoId } = await params;
    if (!isUuidParam(videoId)) return invalidIdResponse();

    const rl = await rateLimit("videoQuicksave", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    // P2-01: quicksave e engagement NOU — refuzat pe conținut retras/privat.
    if (!(await isVideoInteractable(videoId))) {
      return NextResponse.json({ error: "video_not_available" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const explicitCollectionId =
      typeof body.collection_id === "string" ? body.collection_id : null;

    // Resolve target collection
    let targetCollectionId: string | null = null;
    let targetTitle = "";
    let targetIcon = "";

    if (explicitCollectionId) {
      const { rows } = await dbQuery<{ id: string; title: string; icon: string | null }>(
        `SELECT id, title, icon FROM user_collections
         WHERE id = $1 AND user_id = $2`,
        [explicitCollectionId, userId],
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: "Collection not found" }, { status: 404 });
      }
      targetCollectionId = rows[0].id;
      targetTitle = rows[0].title;
      targetIcon = rows[0].icon ?? "📁";
    } else {
      // Pick most-recently-used or fall back to default
      const { rows } = await dbQuery<{
        id: string;
        title: string;
        icon: string | null;
      }>(
        `WITH recent AS (
           SELECT uc.id, uc.title, uc.icon, MAX(uci.created_at) AS last_used
           FROM user_collections uc
           LEFT JOIN user_collection_items uci ON uci.collection_id = uc.id
           WHERE uc.user_id = $1
           GROUP BY uc.id
         )
         SELECT id, title, icon FROM recent
         ORDER BY last_used DESC NULLS LAST,
                  (CASE WHEN title = 'Idei utile' THEN 0 ELSE 1 END),
                  id
         LIMIT 1`,
        [userId],
      );

      if (rows.length > 0) {
        targetCollectionId = rows[0].id;
        targetTitle = rows[0].title;
        targetIcon = rows[0].icon ?? "📁";
      } else {
        // No collections at all — bootstrap "Idei utile"
        const { rows: created } = await dbQuery<{
          id: string;
          title: string;
          icon: string | null;
        }>(
          `INSERT INTO user_collections
             (user_id, title, slug, icon, color, is_default, item_count)
           VALUES ($1, 'Idei utile', 'ideas', '💡', '#F59E0B', true, 0)
           ON CONFLICT (user_id, slug) WHERE slug IS NOT NULL DO UPDATE
             SET updated_at = NOW()
           RETURNING id, title, icon`,
          [userId],
        );
        targetCollectionId = created[0].id;
        targetTitle = created[0].title;
        targetIcon = created[0].icon ?? "💡";
      }
    }

    // Insert with dedup
    const pool = getDb();
    const client = await pool.connect();
    let added = false;
    try {
      await client.query("BEGIN");

      const ins = await client.query(
        `INSERT INTO user_collection_items (collection_id, video_id)
         VALUES ($1, $2)
         ON CONFLICT (collection_id, video_id) DO NOTHING
         RETURNING id`,
        [targetCollectionId, videoId],
      );

      added = (ins.rowCount ?? 0) > 0;
      if (added) {
        await client.query(
          `UPDATE user_collections SET item_count = item_count + 1, updated_at = NOW()
           WHERE id = $1`,
          [targetCollectionId],
        );
        await client.query(
          `UPDATE videos SET save_count = save_count + 1 WHERE id = $1`,
          [videoId],
        );
        await client.query(
          `INSERT INTO feed_events
             (actor_user_id, video_id, event_type, audience, score, source, metadata)
           VALUES ($1, $2, 'video_saved', 'global', 4, 'quicksave', $3::jsonb)`,
          [userId, videoId, JSON.stringify({ collection_id: targetCollectionId })],
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const response = NextResponse.json({
      collection: { id: targetCollectionId, title: targetTitle, icon: targetIcon },
      added,
    });
    setAnonSessionCookie(response, session.anonSessionId);
    return response;
  } catch (err) {
    const anonErr = anonSessionErrorResponse(err);
    if (anonErr) return anonErr;
    logger.error({ err: err }, "[Quicksave] error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
