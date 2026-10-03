import { NextRequest, NextResponse } from "next/server";
import { dbQuery, getDb } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/collections/:id/items/:videoId — remove a video from a collection.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; videoId: string }> },
) {
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rl = await rateLimit("collectionItems", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id: collectionId, videoId } = await params;

    const { rows: owned } = await dbQuery(
      `SELECT id FROM user_collections WHERE id = $1 AND user_id = $2`,
      [collectionId, userId],
    );
    if (owned.length === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const pool = getDb();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const del = await client.query(
        `DELETE FROM user_collection_items
         WHERE collection_id = $1 AND video_id = $2`,
        [collectionId, videoId],
      );

      if ((del.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE user_collections
             SET item_count = GREATEST(item_count - 1, 0), updated_at = NOW()
           WHERE id = $1`,
          [collectionId],
        );
        await client.query(
          `UPDATE videos SET save_count = GREATEST(save_count - 1, 0) WHERE id = $1`,
          [videoId],
        );
      }

      await client.query("COMMIT");
      return NextResponse.json({ ok: true, removed: (del.rowCount ?? 0) > 0 });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err: err }, "[Collection Items DELETE] error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
