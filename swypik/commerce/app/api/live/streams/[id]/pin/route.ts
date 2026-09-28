import { NextRequest, NextResponse } from "next/server";
import { dbQuery, getDb } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { withErrorHandling } from "@/lib/api-handler";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

async function POST_impl(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("liveStreamEdit", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { rows: own } = await dbQuery<{ creator_id: string }>(
    `SELECT creator_id FROM live_streams WHERE id = $1`,
    [id],
  );
  if (!own[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (own[0].creator_id !== session.userId && session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const item_id = Number(body.item_id);
  if (!Number.isSafeInteger(item_id) || item_id <= 0) return NextResponse.json({ error: "item_id_required" }, { status: 400 });
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE live_shop_items SET is_pinned = false WHERE stream_id = $1`, [id]);
    await client.query(`UPDATE live_shop_items SET is_pinned = true WHERE id = $1 AND stream_id = $2`, [item_id, id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
}

export const POST = withErrorHandling(POST_impl);
