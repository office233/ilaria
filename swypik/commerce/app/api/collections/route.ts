import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { CollectionCreateSchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
export async function GET() {
  try {
    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { rows } = await dbQuery(
      `SELECT uc.*, 
        (SELECT COUNT(*) FROM user_collection_items WHERE collection_id = uc.id) AS actual_count
      FROM user_collections uc 
      WHERE user_id = $1 
      ORDER BY is_default DESC, created_at DESC`,
      [userId]
    );

    if (rows.length === 0) {
      // Creează automat colecțiile default
      const defaults = [
        { title: "Salvate", slug: "saved", icon: "🔖", is_default: true, color: "#0D0D0D" },
        { title: "De cumpărat", slug: "to-buy", icon: "🛒", is_default: false, color: "#4F46E5" },
        { title: "Idei utile", slug: "ideas", icon: "💡", is_default: false, color: "#F59E0B" }
      ];
      
      const newCollections = [];
      for (const def of defaults) {
        const { rows: inserted } = await dbQuery(
          `INSERT INTO user_collections (user_id, title, slug, icon, color, is_default, item_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, NOW()) RETURNING *`,
          [userId, def.title, def.slug, def.icon, def.color, def.is_default]
        );
        inserted[0].actual_count = 0;
        newCollections.push(inserted[0]);
      }
      
      return NextResponse.json({ collections: newCollections });
    }

    return NextResponse.json({ collections: rows });
  } catch (error) {
    logger.error({ err: error }, "Collections GET Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getOptionalSocialUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("collections", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const rawBody = await req.json().catch(() => null);
    const parsedBody = parseBody(CollectionCreateSchema, rawBody);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const { title, icon, color } = parsedBody.data;

    const slug = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);

    const { rows } = await dbQuery(
      `INSERT INTO user_collections (user_id, title, slug, icon, color, is_default, item_count, created_at)
       VALUES ($1, $2, $3, $4, $5, false, 0, NOW()) RETURNING *`,
      [userId, title, slug, icon || '📁', color || '#374151']
    );

    const newCollection = rows[0];
    newCollection.actual_count = 0;

    return NextResponse.json({ collection: newCollection });
  } catch (error) {
    logger.error({ err: error }, "Collections POST Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
