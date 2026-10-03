import { NextRequest, NextResponse } from "next/server";
import { dbQuery, getDb } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { CollectionItemAddSchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
export const dynamic = "force-dynamic";

/**
 * POST /api/collections/:id/items
 * Body: { video_id: string, note?: string }
 * Adds a video to a collection (auto-dedup via UNIQUE (collection_id, video_id)).
 * Also keeps user_collections.item_count and videos.save_count consistent
 * and emits a feed_events row for ranking.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rl = await rateLimit("collectionItems", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id: collectionId } = await params;

    if (!isUuidParam(collectionId)) return invalidIdResponse();
    const rawBody = await req.json().catch(() => null);
    const parsedBody = parseBody(CollectionItemAddSchema, rawBody);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const videoId = parsedBody.data.video_id;
    const note = parsedBody.data.note ?? null;

    // Verify ownership of the target collection
    const { rows: owned } = await dbQuery<{ id: string; slug: string | null }>(
      `SELECT id, slug FROM user_collections WHERE id = $1 AND user_id = $2`,
      [collectionId, userId],
    );
    if (owned.length === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const pool = getDb();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const ins = await client.query(
        `INSERT INTO user_collection_items (collection_id, video_id, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (collection_id, video_id) DO NOTHING
         RETURNING id`,
        [collectionId, videoId, note],
      );

      const added = (ins.rowCount ?? 0) > 0;
      if (added) {
        await client.query(
          `UPDATE user_collections SET item_count = item_count + 1, updated_at = NOW()
           WHERE id = $1`,
          [collectionId],
        );
        await client.query(
          `UPDATE videos SET save_count = save_count + 1 WHERE id = $1`,
          [videoId],
        );
        await client.query(
          `INSERT INTO feed_events
             (actor_user_id, video_id, event_type, audience, score, source, metadata)
           VALUES ($1, $2, 'video_saved', 'global', 4, 'collection-add', $3::jsonb)`,
          [userId, videoId, JSON.stringify({ collection_id: collectionId })],
        );
      }

      await client.query("COMMIT");
      return NextResponse.json({ ok: true, added });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err: err }, "[Collection Items POST] error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * GET /api/collections/:id/items — list items in the collection (paginated).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: collectionId } = await params;

    if (!isUuidParam(collectionId)) return invalidIdResponse();
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);

    const { rows: owned } = await dbQuery(
      `SELECT id FROM user_collections WHERE id = $1 AND user_id = $2`,
      [collectionId, userId],
    );
    if (owned.length === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const { rows: items } = await dbQuery(
      `SELECT uci.id, uci.video_id, uci.note, uci.position, uci.created_at,
              v.title, v.thumbnail_url, v.playback_url, v.duration_ms,
              v.view_count, v.like_count,
              u.display_name AS creator_name, u.username AS creator_username
       FROM user_collection_items uci
       JOIN videos v ON v.id = uci.video_id
       LEFT JOIN users u ON u.id = v.creator_id
       WHERE uci.collection_id = $1
       ORDER BY uci.position DESC, uci.created_at DESC
       LIMIT $2 OFFSET $3`,
      [collectionId, limit, offset],
    );

    return NextResponse.json({ items, limit, offset });
  } catch (err) {
    logger.error({ err: err }, "[Collection Items GET] error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
