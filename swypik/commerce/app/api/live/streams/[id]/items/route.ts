import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { rateLimit } from "@/lib/security/rate-limit";
import { z } from "zod";
import { parseBody } from "@/lib/validation/schemas";

/** Body validat: înainte, un flash_until invalid dădea RangeError și display_order NaN → 500. */
const ItemSchema = z.object({
  product_id: z.string().trim().min(1).max(64),
  display_order: z.number().int().min(0).max(10_000).default(0),
  is_pinned: z.boolean().default(false),
  flash_price_cents: z.number().int().positive().max(100_000_000).nullish(),
  flash_until: z.string().datetime({ offset: true }).nullish(),
});

export const dynamic = "force-dynamic";

async function isOwner(streamId: string, userId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ creator_id: string }>(
    `SELECT COALESCE(creator_user_id::text, creator_id) AS creator_id
       FROM live_streams WHERE id = $1`,
    [streamId],
  );
  return rows[0]?.creator_id === userId;
}

async function POST_impl(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("liveStreamEdit", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  if (!(await isOwner(id, session.userId)) && session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = parseBody(ItemSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { product_id, display_order, is_pinned } = parsed.data;
  const flash_price_cents = parsed.data.flash_price_cents ?? null;
  const flash_until = parsed.data.flash_until ? new Date(parsed.data.flash_until).toISOString() : null;

  // Produsul trebuie să fie al gazdei (vânzătorul/comerciantul din spatele lui) —
  // înainte, orice proprietar de stream putea atașa ORICE produs cu preț flash (audit live §4).
  const { rows: prodRows } = await dbQuery<{ price_cents: number | null; seller_user_id: string | null; merchant_user_id: string | null }>(
    `SELECT p.price_cents, s.user_id::text AS seller_user_id, mm.owner_user_id::text AS merchant_user_id
       FROM marketplace_products p
       LEFT JOIN sellers s ON s.id = p.seller_id
       LEFT JOIN marketplace_merchants mm ON mm.id = p.merchant_id
      WHERE p.id::text = $1
      LIMIT 1`,
    [product_id],
  );
  if (prodRows.length === 0) {
    return NextResponse.json({ error: "product_not_found" }, { status: 400 });
  }
  const prod = prodRows[0];
  const isAuthorized =
    session.role === "admin" || prod.seller_user_id === session.userId || prod.merchant_user_id === session.userId;
  if (!isAuthorized) {
    logger.warn(
      { userId: session.userId, streamId: id, product_id },
      "[live.items] product_ownership_denied",
    );
    return NextResponse.json({ error: "product_ownership_denied" }, { status: 403 });
  }

  if (flash_price_cents !== null) {
    if (!Number.isFinite(flash_price_cents) || flash_price_cents < 50) {
      return NextResponse.json({ error: "flash_price_too_low" }, { status: 400 });
    }
    if (prod.price_cents != null && flash_price_cents > prod.price_cents) {
      return NextResponse.json({ error: "flash_price_above_original" }, { status: 400 });
    }
    logger.info(
      { userId: session.userId, streamId: id, product_id, flash_price_cents, original_cents: prod.price_cents },
      "[live.items] flash_price_set",
    );
  }

  const { rows } = await dbQuery<{ id: number }>(
    `INSERT INTO live_shop_items (stream_id, product_id, display_order, is_pinned, flash_price_cents, flash_until)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [id, product_id, display_order, is_pinned, flash_price_cents, flash_until],
  );
  return NextResponse.json({ id: rows[0].id });
}

async function GET_impl(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const { rows } = await dbQuery(
    `SELECT lsi.*, p.title, p.image_url, p.price_cents, p.currency
       FROM live_shop_items lsi
       LEFT JOIN marketplace_products p ON p.id::text = lsi.product_id
      WHERE lsi.stream_id = $1
      ORDER BY lsi.is_pinned DESC, lsi.display_order ASC, lsi.created_at ASC`,
    [id],
  );
  return NextResponse.json({ items: rows });
}

export const POST = withErrorHandling(POST_impl);
export const GET = withErrorHandling(GET_impl);
