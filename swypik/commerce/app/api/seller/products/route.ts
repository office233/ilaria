/**
 * GET  /api/seller/products?limit=&offset=&status=  → catalogul seller-ului
 *      (+ comisionul platformei și moneda, ca UI-ul să nu le scrie în cod)
 * POST /api/seller/products                          → produs nou (cu variante)
 *
 * `video_url` nu mai creează rânduri `videos` publicate direct (ocolea
 * transcodarea și moderarea): clipurile trec prin fluxul de upload standard.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { labelProduct } from "@/lib/moderation/labelProduct";
import { autoEmbedProduct } from "@/lib/ai/auto-embed";
import { rateLimit } from "@/lib/security/rate-limit";
import { SellerProductCreateSchema, parseBody } from "@/lib/validation/schemas";
import { paginationSchema, queryObject } from "@/lib/validation/params";
import { translateProductToLocales } from "@/lib/ai/product-translator";
import { SELLER_PRODUCT_COLS, upsertSellerProductTranslation } from "@/lib/seller/products";
import { inventoryStatusFor, sellerProductSlug } from "@/lib/seller/product-schemas";
import { sellerRequestLocale, sellerTranslationTargets } from "@/lib/seller/request-locale";
import { sellerCommissionBps, sellerCurrency } from "@/lib/seller/config";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ListQuery = paginationSchema(20, 100).extend({
  status: z.enum(["active", "draft", "out_of_stock", "archived", "disabled"]).optional(),
});

export async function GET(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const parsed = ListQuery.safeParse(queryObject(new URL(req.url), ["limit", "offset", "status"]));
  if (!parsed.success) return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  const { limit, offset, status } = parsed.data;

  try {
    const { rows } = await dbQuery(
      `SELECT ${SELLER_PRODUCT_COLS}
         FROM marketplace_products
        WHERE seller_id = $1
          AND CASE
                WHEN $4::text IS NULL THEN status <> 'archived'
                WHEN $4::text = 'out_of_stock' THEN status <> 'archived' AND (status = 'out_of_stock' OR inventory_status = 'out_of_stock')
                ELSE status = $4::text
              END
        ORDER BY updated_at DESC, id
        LIMIT $2 OFFSET $3`,
      [sellerId, limit + 1, offset, status ?? null],
    );
    return NextResponse.json({
      success: true,
      products: rows.slice(0, limit),
      limit,
      offset,
      hasMore: rows.length > limit,
      commissionBps: sellerCommissionBps(),
      currency: sellerCurrency(),
    });
  } catch (error) {
    logger.error({ err: error }, "[Seller Products API] GET Error");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

async function insertVariants(productId: string, currency: string, basePriceCents: number, variants: NonNullable<z.infer<typeof SellerProductCreateSchema>["variants"]>) {
  // Un singur INSERT multi-VALUES, atomic: ori intră toate variantele, ori niciuna.
  const values: string[] = [];
  const params: unknown[] = [productId, currency];
  for (const v of variants) {
    params.push(v.sku ?? null, v.title ?? null, JSON.stringify(v.attributes ?? {}), v.price_cents ?? basePriceCents, v.inventory_quantity ?? null);
    const base = params.length - 5;
    values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}::jsonb, $2, $${base + 4}, $${base + 5}, 'active', '{}'::jsonb)`);
  }
  await dbQuery(
    `INSERT INTO marketplace_product_variants (
       product_id, sku, title, attributes, currency, price_cents, inventory_quantity, status, metadata
     ) VALUES ${values.join(", ")}`,
    params,
  );
}

export async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit("sellerProducts", sellerId);
  if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(SellerProductCreateSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  const d = parsed.data;

  if (d.compare_at_price && d.compare_at_price < d.price) {
    return NextResponse.json({ success: false, error: "compare_below_price" }, { status: 422 });
  }
  if (d.shipping_days_min !== undefined && d.shipping_days_max !== undefined && d.shipping_days_max < d.shipping_days_min) {
    return NextResponse.json({ success: false, error: "invalid_shipping_days" }, { status: 400 });
  }

  try {
    const priceCents = Math.round(d.price * 100);
    const slug = sellerProductSlug(d.title);
    const meta: Record<string, unknown> = { seller_id: sellerId, available_stock: d.stock };
    if (d.sku) meta.sku = d.sku;
    if (d.barcode) meta.barcode = d.barcode;
    if (d.image_urls?.length) meta.image_urls = d.image_urls;
    if (d.shipping_days_min !== undefined) meta.shipping_days_min = d.shipping_days_min;
    if (d.shipping_days_max !== undefined) meta.shipping_days_max = d.shipping_days_max;
    if (d.courier) meta.courier = d.courier;

    const { rows } = await dbQuery(
      `INSERT INTO marketplace_products (
         source_type, seller_id, title, slug, description, brand,
         price_cents, compare_at_price_cents, supplier_cost_cents, shipping_cost_cents,
         category, taxonomy_node_slug, currency, status, inventory_status, image_url, metadata
       ) VALUES ('seller', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13, $14, $15::jsonb)
       RETURNING ${SELLER_PRODUCT_COLS}`,
      [
        sellerId,
        d.title,
        slug,
        d.description ?? null,
        d.brand ?? null,
        priceCents,
        d.compare_at_price ? Math.round(d.compare_at_price * 100) : null,
        d.supplier_cost ? Math.round(d.supplier_cost * 100) : null,
        d.shipping_cost !== undefined ? Math.round(d.shipping_cost * 100) : null,
        d.category ?? "General",
        d.taxonomy_node_slug ?? null,
        d.currency,
        inventoryStatusFor(d.stock),
        d.image_urls?.[0] ?? null,
        JSON.stringify(meta),
      ],
    );
    const product = rows[0];
    const productId: string | undefined = product?.id;
    if (!productId) return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });

    if (d.variants?.length) {
      await insertVariants(productId, d.currency, priceCents, d.variants).catch((err) =>
        logger.warn({ err, productId }, "[seller/products] variant insert failed"),
      );
    }

    autoEmbedProduct(productId, product.title, d.description ?? null);
    labelProduct({ id: productId, title: product.title, description: d.description ?? null, category: product.category ?? null }).catch(() => {});

    const locale = await sellerRequestLocale();
    await upsertSellerProductTranslation({ productId, locale, title: d.title, description: d.description ?? null, slug }).catch((err) =>
      logger.warn({ err, productId }, "[seller/products] translation insert failed"),
    );
    translateProductToLocales({
      productId,
      sourceLocale: locale,
      title: d.title,
      description: d.description ?? null,
      targetLocales: sellerTranslationTargets(locale),
    }).catch((err) => logger.warn({ err, productId }, "[seller/products] translate fanout failed"));

    return NextResponse.json({ success: true, product });
  } catch (error) {
    if ((error as { code?: string })?.code === "23514") {
      return NextResponse.json({ success: false, error: "price_below_cost" }, { status: 422 });
    }
    logger.error({ err: error }, "[Seller Products API] POST Error");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
