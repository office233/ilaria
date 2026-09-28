import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";

import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";
/**
 * GET /api/products/[id]/videos
 * Public endpoint — returns videos that reference a given product.
 * product_refs schema: [{"source":"...","product_id":"<uuid>"}] OR legacy ["<uuid>"].
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params;

  if (!productId) {
    return NextResponse.json({ videos: [] });
  }

  try {
    const { rows } = await dbQuery(
      `SELECT
         v.id,
         v.title,
         v.description,
         v.playback_url,
         v.thumbnail_url,
         v.duration_ms,
         v.view_count,
         v.like_count,
         v.published_at,
         u.display_name AS creator_name,
         u.id            AS creator_id
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       WHERE v.status     = 'ready'
         AND v.visibility = 'public'
         AND v.effective_label = 'safe'
         AND COALESCE(v.is_hidden, false) = false
         -- Containment (@>) folosește indexul GIN existent pe product_refs
         -- (jsonb_path_ops); EXISTS(jsonb_array_elements …) scana toate clipurile.
         AND (
           v.product_refs @> jsonb_build_array(jsonb_build_object('product_id', $1::text))
           OR v.product_refs @> jsonb_build_array($1::text)
         )
       ORDER BY v.view_count DESC NULLS LAST, v.published_at DESC NULLS LAST
       LIMIT 12`,
      [productId]
    );

    const videos = rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      playbackUrl: r.playback_url,
      thumbnailUrl: r.thumbnail_url,
      durationSeconds: r.duration_ms ? Math.round(r.duration_ms / 1000) : 0,
      viewCount: Number(r.view_count) || 0,
      likeCount: Number(r.like_count) || 0,
      publishedAt: r.published_at,
      creatorName: r.creator_name,
      creatorId: r.creator_id,
    }));

    return applyCachePolicy(NextResponse.json({ videos }), "products/[id]/videos", req);
  } catch (err: any) {
    logger.error({ err: err.message }, "[products/videos] query error:");
    return NextResponse.json({ videos: [] });
  }
}
