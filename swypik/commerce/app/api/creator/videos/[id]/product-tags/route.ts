/**
 * GET/PUT /api/creator/videos/[id]/product-tags
 *
 * Tag-uri de produse pe clip, cu timestamp pentru overlay-ul
 * "vezi produsul" din player. Foloseste tabela EXISTENTA
 * video_product_links (placement='overlay', start_ms/end_ms) —
 * nu exista o tabela separata video_product_tags.
 *
 * PUT inlocuieste atomic setul de tag-uri overlay al clipului
 * (max 10). Aceleasi reguli ca restul fluxului video: rol de autor
 * (creator/seller/admin), clip propriu nesters (loadOwnedVideo), produse
 * eligibile pentru feed (altfel 422, nu FK → 500).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery, getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { loadOwnedVideo } from "@/lib/video/auth";
import { isFeedEligibleProduct } from "@/lib/video/product-eligibility";
import { errorResponse, guardAuthor, jsonError, readJson, validId } from "@/lib/video/upload/http";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAGS = 10;

const TagSchema = z.object({
    product_id: z.string().regex(UUID_RE, "product_id must be a UUID"),
    start_ms: z.number().int().min(0),
    end_ms: z.number().int().min(0).nullable().optional(),
    label: z.string().max(120).optional(),
});

const PutSchema = z.object({
    tags: z.array(TagSchema).max(MAX_TAGS),
});

type Ctx = { params: Promise<{ id: string }> };

async function ownedVideoId(ctx: Ctx, limitKey?: "creatorVideoEdit") {
    const guard = await guardAuthor(limitKey);
    if (!guard.ok) return { error: guard.response } as const;
    const { id } = await ctx.params;
    if (!validId(id)) return { error: jsonError(400, "invalid_id") } as const;
    const video = await loadOwnedVideo(id, guard.author);
    if (!video) return { error: jsonError(404, "not_found") } as const;
    if (video === "forbidden") return { error: jsonError(403, "forbidden") } as const;
    return { id: video.id, author: guard.author } as const;
}

export async function GET(_req: Request, ctx: Ctx) {
    try {
        const owned = await ownedVideoId(ctx);
        if ("error" in owned) return owned.error;
        const { rows } = await dbQuery(
            `SELECT vpl.product_id, vpl.start_ms, vpl.end_ms, vpl.sort_order,
              vpl.metadata->>'label' AS label,
              p.title, p.image_url, p.price_cents, p.currency
         FROM video_product_links vpl
         JOIN marketplace_products p ON p.id = vpl.product_id
        WHERE vpl.video_id = $1 AND vpl.placement = 'overlay'
        ORDER BY vpl.sort_order ASC, vpl.created_at ASC`,
            [owned.id],
        );
        return NextResponse.json({ tags: rows }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
        return errorResponse(err, "product-tags get");
    }
}

export async function PUT(req: Request, ctx: Ctx) {
    try {
        const owned = await ownedVideoId(ctx, "creatorVideoEdit");
        if ("error" in owned) return owned.error;
        const body = await readJson(req, PutSchema);
        if (!body.ok) return body.response;
        const tags = body.data.tags;
        if (tags.some((tag) => tag.end_ms != null && tag.end_ms < tag.start_ms)) {
            return jsonError(400, "invalid_range");
        }
        for (const productId of new Set(tags.map((t) => t.product_id))) {
            if (!(await isFeedEligibleProduct(productId))) return jsonError(422, "product_not_eligible");
        }

        const client = await getDb().connect();
        try {
            await client.query("BEGIN");
            await client.query(`DELETE FROM video_product_links WHERE video_id = $1 AND placement = 'overlay'`, [owned.id]);
            for (let i = 0; i < tags.length; i++) {
                const tag = tags[i];
                await client.query(
                    `INSERT INTO video_product_links
             (video_id, product_id, placement, start_ms, end_ms, sort_order, metadata)
           VALUES ($1, $2, 'overlay', $3, $4, $5, $6::jsonb)
           ON CONFLICT DO NOTHING`,
                    [owned.id, tag.product_id, tag.start_ms, tag.end_ms ?? null, i,
                        JSON.stringify(tag.label ? { label: tag.label } : {})],
                );
            }
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => undefined);
            // Produsul a dispărut între verificare și scriere.
            if ((e as { code?: string })?.code === "23503") return jsonError(422, "product_not_eligible");
            throw e;
        } finally {
            client.release();
        }

        logger.info({ videoId: owned.id, userId: owned.author.userId, count: tags.length }, "video product tags updated");
        return NextResponse.json({ ok: true, count: tags.length });
    } catch (err) {
        return errorResponse(err, "product-tags put");
    }
}
