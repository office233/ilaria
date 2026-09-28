import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getCreatorUserId } from "@/lib/creator/session";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

/**
 * GET /api/creator/videos
 *
 * Returns the authenticated creator's video library from the `videos` table
 * (migration 0001 schema), joined with video_assets for source info.
 */
export async function GET() {
  try {
    const creatorId = await getCreatorUserId();
    if (!creatorId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { rows } = await dbQuery(
      `
      SELECT 
        v.id,
        v.status,
        v.title,
        v.description,
        v.playback_url   AS video_url,
        v.thumbnail_url,
        v.duration_ms,
        v.product_refs,
        v.visibility,
        v.view_count,
        v.like_count,
        v.created_at,
        pref.product_id,
        p.title          AS product_title,
        p.image_url      AS product_image,
        va.object_key     AS source_object_key,
        va.public_url     AS source_public_url,
        va.status         AS asset_status
      FROM videos v
      LEFT JOIN LATERAL (
        SELECT COALESCE(v.product_refs->0->>'product_id', v.product_refs->>0) AS product_id
        WHERE jsonb_typeof(v.product_refs) = 'array' AND jsonb_array_length(v.product_refs) > 0
      ) pref ON true
      LEFT JOIN marketplace_products p ON p.id::text = pref.product_id
      LEFT JOIN LATERAL (
        SELECT object_key, public_url, status
        FROM video_assets
        WHERE video_id = v.id AND asset_type = 'source'
        ORDER BY created_at DESC
        LIMIT 1
      ) va ON true
      WHERE v.creator_id = $1
        AND v.status <> 'deleted'
      ORDER BY v.created_at DESC
      LIMIT 50
      `,
      [creatorId]
    );

    const videos = rows.map((r: any) => {
      let productId: string | null = r.product_id || null;
      try {
        const refs = typeof r.product_refs === "string"
          ? JSON.parse(r.product_refs)
          : r.product_refs;
        if (!productId && Array.isArray(refs) && refs.length > 0) {
          const firstRef = refs[0];
          productId = typeof firstRef === "string"
            ? firstRef
            : firstRef?.product_id || firstRef?.id || null;
        }
      } catch { /* ignore */ }

      return {
        id: r.id,
        status: r.status,
        video_url: r.video_url,
        thumbnail_url: r.thumbnail_url || null,
        description: r.description || r.title,
        created_at: r.created_at,
        product_title: r.product_title || null,
        product_id: productId,
        product_image: r.product_image || null,
        duration_ms: r.duration_ms,
        visibility: r.visibility,
        view_count: r.view_count,
        like_count: r.like_count ?? 0,
      };
    });

    return NextResponse.json({ videos });
  } catch (error: any) {
    logger.error({ err: error }, "Creator Videos API Error:");
    return NextResponse.json(
      { error: "Failed to fetch creator videos" },
      { status: 500 }
    );
  }
}
