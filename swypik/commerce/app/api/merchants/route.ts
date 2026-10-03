/**
 * Comercianți locali (restaurante, magazine, farmacii) — înregistrare + listare.
 *
 * GET  /api/merchants?city=&kind=&cuisine=&q=&sort=&mode=&open=1&lat=&lng=  → listă publică (lib/food/merchant-list.ts)
 * POST /api/merchants                      → seller își creează comerciantul
 * PATCH /api/merchants                     → actualizare (program, taxe, status)
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { MerchantCreateSchema, MerchantUpdateSchema, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { LISTING_MODE_SELECT_SQL } from "@/lib/merchants/listing-mode";
import { merchantSlug } from "@/lib/merchants/slug";
import { normalizeCuisines } from "@/lib/merchants/cuisines";
import { buildMerchantListSql, parseMerchantListQuery } from "@/lib/food/merchant-list";
import { toMerchantSummary, type MerchantRow } from "@/lib/food/merchant-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_COLS = `
  id, kind, name, slug, description, cuisine_types, phone, address,
  location_country, location_city, location_lat, location_lng,
  delivery_radius_km, min_order_cents, delivery_fee_cents, avg_prep_minutes,
  opening_hours, is_open_override, status, image_url, created_at, source,
  -- Rating-ul din DB e seed (nu există încă recenzii reale pentru restaurante):
  -- nu-l expunem public.
  NULL::numeric AS rating,
  ${LISTING_MODE_SELECT_SQL}
`;

export async function GET(req: Request) {
  try {
    const query = parseMerchantListQuery(new URL(req.url));
    const { sql, params } = buildMerchantListSql(query);
    const { rows } = await dbQuery<MerchantRow>(sql, params);
    const now = new Date();
    const merchants = rows.map((r) => toMerchantSummary(r, now));
    return NextResponse.json({
      success: true,
      // „Deschis acum” se calculează în aplicație (opening_hours e jsonb).
      merchants: query.open ? merchants.filter((m) => m.is_open === true) : merchants,
      page: query.page,
      has_more: rows.length === query.limit,
    });
  } catch (error: unknown) {
    logger.error({ err: error }, "[merchants] GET error");
    return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("sellerProducts", `merchant:${sellerId}`);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(MerchantCreateSchema, raw);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const d = parsed.data;

    // Un seller poate avea mai mulți comercianți (lanț), dar slug-ul e unic.
    const slug = merchantSlug(d.name);

    const { rows } = await dbQuery(
      `INSERT INTO local_merchants (
         seller_id, kind, name, slug, description, cuisine_types,
         phone, email, address, location_country, location_city,
         location_lat, location_lng, delivery_radius_km,
         min_order_cents, delivery_fee_cents, avg_prep_minutes,
         opening_hours, image_url, status, listing_mode
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17,
         $18::jsonb, $19, 'pending', 'orderable'
       )
       RETURNING ${PUBLIC_COLS}`,
      [
        sellerId,
        d.kind,
        d.name,
        slug,
        d.description ?? null,
        normalizeCuisines(d.cuisine_types),
        d.phone,
        d.email ?? null,
        d.address,
        d.location_country,
        d.location_city,
        d.location_lat ?? null,
        d.location_lng ?? null,
        d.delivery_radius_km ?? 5,
        d.min_order_cents ?? 0,
        d.delivery_fee_cents ?? 0,
        d.avg_prep_minutes ?? 20,
        JSON.stringify(d.opening_hours ?? {}),
        d.image_url ?? null,
      ],
    );

    return NextResponse.json({ success: true, merchant: rows[0] });
  } catch (error: unknown) {
    const e = error as { code?: string };
    if (e?.code === "23505") {
      return NextResponse.json({ success: false, error: "Există deja un comerciant cu acest nume." }, { status: 409 });
    }
    logger.error({ err: error }, "[merchants] POST error");
    return NextResponse.json({ success: false, error: "Eroare la înregistrare." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(MerchantUpdateSchema, raw);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const { merchant_id, ...d } = parsed.data;

    const sets: string[] = [];
    const params: unknown[] = [merchant_id, sellerId];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (d.name !== undefined) push("name", d.name);
    if (d.description !== undefined) push("description", d.description);
    if (d.cuisine_types !== undefined) push("cuisine_types", normalizeCuisines(d.cuisine_types));
    if (d.phone !== undefined) push("phone", d.phone);
    if (d.address !== undefined) push("address", d.address);
    if (d.location_lat !== undefined) push("location_lat", d.location_lat);
    if (d.location_lng !== undefined) push("location_lng", d.location_lng);
    if (d.delivery_radius_km !== undefined) push("delivery_radius_km", d.delivery_radius_km);
    if (d.min_order_cents !== undefined) push("min_order_cents", d.min_order_cents);
    if (d.delivery_fee_cents !== undefined) push("delivery_fee_cents", d.delivery_fee_cents);
    if (d.avg_prep_minutes !== undefined) push("avg_prep_minutes", d.avg_prep_minutes);
    if (d.image_url !== undefined) push("image_url", d.image_url);
    if (d.is_open_override !== undefined) push("is_open_override", d.is_open_override);
    if (d.opening_hours !== undefined) {
      params.push(JSON.stringify(d.opening_hours));
      sets.push(`opening_hours = $${params.length}::jsonb`);
    }

    if (!sets.length) {
      return NextResponse.json({ success: false, error: "Nimic de actualizat." }, { status: 400 });
    }
    sets.push("updated_at = now()");

    const { rows } = await dbQuery(
      `UPDATE local_merchants SET ${sets.join(", ")}
        WHERE id = $1 AND seller_id = $2
        RETURNING ${PUBLIC_COLS}`,
      params,
    );
    if (!rows.length) {
      return NextResponse.json({ success: false, error: "Comerciantul nu există." }, { status: 404 });
    }
    return NextResponse.json({ success: true, merchant: rows[0] });
  } catch (error: unknown) {
    logger.error({ err: error }, "[merchants] PATCH error");
    return NextResponse.json({ success: false, error: "Eroare la actualizare." }, { status: 500 });
  }
}
