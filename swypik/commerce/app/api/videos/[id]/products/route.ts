/**
 * GET /api/videos/[id]/products — tag-urile de produse ale unui clip
 * (public, pentru overlay-ul "vezi produsul" din player).
 *
 * Citeste din video_product_links (placement='overlay') doar pentru
 * clipuri publice, ready si aprobate.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OverlayTagRow = {
    product_id: string;
    start_ms: number | null;
    end_ms: number | null;
    label: string | null;
    title: string;
    image_url: string | null;
    price_cents: number | null;
    currency: string;
};

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ error: "Invalid video id" }, { status: 400 });
        }

        const { rows } = await dbQuery<OverlayTagRow>(
            `SELECT vpl.product_id, vpl.start_ms, vpl.end_ms,
              vpl.metadata->>'label' AS label,
              p.title, p.image_url, p.price_cents, p.currency
         FROM video_product_links vpl
         JOIN videos v ON v.id = vpl.video_id
         JOIN marketplace_products p ON p.id = vpl.product_id
        WHERE vpl.video_id = $1
          AND vpl.placement = 'overlay'
          AND v.visibility = 'public'
          AND v.status = 'ready'
                    -- Aliniat cu /api/explore/feed (care NU filtreaza pe moderation_status):
                    -- clip vizibil in feed => overlay-ul de produs trebuie sa apara si el.
                    -- Blocam doar respinsele explicit.
                    AND COALESCE(v.moderation_status, 'approved') <> 'rejected'
                    AND v.is_hidden = false
          AND p.status = 'active'
        ORDER BY vpl.sort_order ASC, vpl.created_at ASC
        LIMIT 10`,
            [id]
        );

        return applyCachePolicy(NextResponse.json({ tags: rows }), "videos/[id]/products", req);
    } catch (e) {
        logger.error({ err: e }, "video products GET failed");
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
