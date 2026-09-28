import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { ProductReviewPatchSchema, parseBody } from "@/lib/validation/schemas";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getAuthSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("productReviewEdit", session.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id } = await params;

    if (!isUuidParam(id)) return invalidIdResponse();
    const rawBody = await req.json().catch(() => null);
    const parsedBody = parseBody(ProductReviewPatchSchema, rawBody);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const body = parsedBody.data;

    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT user_id FROM product_reviews WHERE id = $1 LIMIT 1`,
      [id]
    );
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.user_id !== session.userId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (body.rating !== undefined) {
      updates.push(`rating = $${i++}`);
      values.push(body.rating);
    }
    if (body.title !== undefined) {
      updates.push(`title = $${i++}`);
      values.push(body.title);
    }
    if (body.body !== undefined) {
      updates.push(`body = $${i++}`);
      values.push(body.body);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "no_changes" }, { status: 400 });
    }
    updates.push(`updated_at = now()`);
    values.push(id);

    await dbQuery(
      `UPDATE product_reviews SET ${updates.join(", ")} WHERE id = $${i}`,
      values
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    logger.error({ err: error }, "[Reviews PATCH]");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getAuthSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("productReviewEdit", session.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { id } = await params;

    if (!isUuidParam(id)) return invalidIdResponse();

    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT user_id FROM product_reviews WHERE id = $1 LIMIT 1`,
      [id]
    );
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.user_id !== session.userId && session.role !== "admin") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await dbQuery(`DELETE FROM product_reviews WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    logger.error({ err: error }, "[Reviews DELETE]");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
