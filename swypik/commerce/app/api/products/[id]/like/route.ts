import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { anonSessionErrorResponse, getOrCreateSocialUser, setAnonSessionCookie } from "@/lib/social/session";
import { logger } from "@/lib/logger";
import { UUID_RE } from "@/lib/validation/uuid";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/** POST /api/products/[id]/like — toggle like pe un produs (anon OK). */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: productId } = await params;
        if (!UUID_RE.test(productId)) {
            return NextResponse.json({ error: "invalid_id" }, { status: 400 });
        }

        const { userId, anonSessionId } = await getOrCreateSocialUser();
        const rl = await rateLimit("productLike", userId);
        if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
        // ANTI-FRAUD: like-ul anonim permite rotirea userId-ului prin stergerea
        // cookie-ului, deci contorul e inflatabil fara o limita pe IP.
        const rlIp = await rateLimit("productLike", `ip:${getClientIP(request)}`, { limit: 40, window: 60 });
        if (!rlIp.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

        const pool = getDb();
        const client = await pool.connect();
        let liked = false;
        let likeCount = 0;
        try {
            await client.query("BEGIN");

            const exists = await client.query(
                "SELECT id FROM marketplace_products WHERE id = $1",
                [productId]
            );
            if (!exists.rowCount) {
                await client.query("ROLLBACK");
                return NextResponse.json({ error: "not_found" }, { status: 404 });
            }

            const check = await client.query(
                "SELECT id FROM likes WHERE user_id = $1 AND product_id = $2",
                [userId, productId]
            );

            if (check.rowCount) {
                await client.query("DELETE FROM likes WHERE id = $1", [check.rows[0].id]);
                liked = false;
            } else {
                await client.query(
                    "INSERT INTO likes (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    [userId, productId]
                );
                liked = true;
            }

            const stats = await client.query(
                `INSERT INTO product_stats (product_id, like_count, updated_at)
         VALUES ($1, (SELECT COUNT(*) FROM likes WHERE product_id = $1), now())
         ON CONFLICT (product_id) DO UPDATE
           SET like_count = (SELECT COUNT(*) FROM likes WHERE product_id = $1),
               updated_at = now()
         RETURNING like_count`,
                [productId]
            );
            likeCount = Number(stats.rows[0]?.like_count) || 0;

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => { });
            throw err;
        } finally {
            client.release();
        }

        const response = NextResponse.json({ liked, likeCount, like_count: likeCount });
        setAnonSessionCookie(response, anonSessionId);
        return response;
    } catch (error) {
        const anonErr = anonSessionErrorResponse(error);
        if (anonErr) return anonErr;
        logger.error({ error: String(error) }, "product like failed");
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
}
