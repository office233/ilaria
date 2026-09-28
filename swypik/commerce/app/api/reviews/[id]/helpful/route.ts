import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery, getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const client = await getDb().connect();
  try {
    const session = await getAuthSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("reviewHelpful", session.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id } = await params;

    if (!isUuidParam(id)) return invalidIdResponse();

    await client.query("BEGIN");

    const exists = await client.query<{ review_id: string }>(
      `SELECT review_id FROM review_helpful_votes WHERE review_id = $1 AND user_id = $2`,
      [id, session.userId]
    );

    let helpful: number;
    let voted: boolean;

    if (exists.rowCount && exists.rowCount > 0) {
      await client.query(
        `DELETE FROM review_helpful_votes WHERE review_id = $1 AND user_id = $2`,
        [id, session.userId]
      );
      const upd = await client.query<{ helpful_count: number }>(
        `UPDATE product_reviews
            SET helpful_count = GREATEST(helpful_count - 1, 0)
          WHERE id = $1
          RETURNING helpful_count`,
        [id]
      );
      helpful = upd.rows[0]?.helpful_count ?? 0;
      voted = false;
    } else {
      const reviewCheck = await client.query<{ id: string }>(
        `SELECT id FROM product_reviews WHERE id = $1`,
        [id]
      );
      if (reviewCheck.rowCount === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      await client.query(
        `INSERT INTO review_helpful_votes (review_id, user_id) VALUES ($1, $2)`,
        [id, session.userId]
      );
      const upd = await client.query<{ helpful_count: number }>(
        `UPDATE product_reviews SET helpful_count = helpful_count + 1 WHERE id = $1 RETURNING helpful_count`,
        [id]
      );
      helpful = upd.rows[0]?.helpful_count ?? 0;
      voted = true;
    }

    await client.query("COMMIT");

    return NextResponse.json({ ok: true, voted, helpfulCount: helpful });
  } catch (error: any) {
    try { await client.query("ROLLBACK"); } catch {}
    logger.error({ err: error }, "[Reviews helpful POST]");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  } finally {
    client.release();
  }
}
