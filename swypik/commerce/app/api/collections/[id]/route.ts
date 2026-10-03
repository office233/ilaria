import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { CollectionPatchSchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: collectionId } = await params;
    if (!isUuidParam(collectionId)) return invalidIdResponse();
    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { rows: collRows } = await dbQuery(
      `SELECT * FROM user_collections WHERE id = $1 AND user_id = $2`,
      [collectionId, userId]
    );

    if (collRows.length === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const collection = collRows[0];

    const { rows: items } = await dbQuery(
      `SELECT uci.*, v.title, v.thumbnail_url, v.playback_url, v.duration_ms, v.view_count,
              u.display_name AS creator_name
       FROM user_collection_items uci
       JOIN videos v ON uci.video_id = v.id
       LEFT JOIN users u ON v.creator_id = u.id
       WHERE uci.collection_id = $1
       ORDER BY uci.created_at DESC`,
      [collectionId]
    );

    return NextResponse.json({ collection, items });
  } catch (error) {
    logger.error({ err: error }, "Collection GET Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: collectionId } = await params;
    if (!isUuidParam(collectionId)) return invalidIdResponse();
    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("collections", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const rawBody = await req.json().catch(() => null);
    const parsedBody = parseBody(CollectionPatchSchema, rawBody);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const { title, icon, color } = parsedBody.data;

    const { rows: collRows } = await dbQuery(
      `SELECT * FROM user_collections WHERE id = $1 AND user_id = $2`,
      [collectionId, userId]
    );

    if (collRows.length === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const current = collRows[0];
    const newTitle = title || current.title;
    const newIcon = icon || current.icon;
    const newColor = color || current.color;
    
    let newSlug = current.slug;
    if (title && title !== current.title) {
        newSlug = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    }

    const { rows } = await dbQuery(
      `UPDATE user_collections SET title = $1, slug = $2, icon = $3, color = $4 WHERE id = $5 RETURNING *`,
      [newTitle, newSlug, newIcon, newColor, collectionId]
    );

    return NextResponse.json({ collection: rows[0] });
  } catch (error) {
    logger.error({ err: error }, "Collection PATCH Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: collectionId } = await params;
    if (!isUuidParam(collectionId)) return invalidIdResponse();
    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("collections", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { rows: collRows } = await dbQuery(
      `SELECT * FROM user_collections WHERE id = $1 AND user_id = $2`,
      [collectionId, userId]
    );

    if (collRows.length === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    if (collRows[0].is_default) {
      return NextResponse.json({ error: "Cannot delete default collection" }, { status: 400 });
    }

    await dbQuery(`DELETE FROM user_collections WHERE id = $1`, [collectionId]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, "Collection DELETE Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
