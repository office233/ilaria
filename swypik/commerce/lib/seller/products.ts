/**
 * Catalogul seller-ului: citire pentru editare, editare (preț, stoc, imagini,
 * categorie, livrare, status, variante) și arhivare. Proprietatea se verifică în
 * fiecare query (`seller_id = $sellerId`).
 */
import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { inventoryStatusFor, type SellerProductUpdate, type SellerVariantUpdate } from "./product-schemas";

export const SELLER_PRODUCT_COLS = `
  id, title, slug, description, brand, price_cents, compare_at_price_cents, supplier_cost_cents,
  shipping_cost_cents, currency, category, taxonomy_node_slug, status, inventory_status, image_url,
  source_type, supplier_product_id, metadata, created_at, updated_at`;

export type SellerVariantRow = {
  id: string;
  sku: string | null;
  title: string | null;
  attributes: Record<string, string>;
  price_cents: number | null;
  inventory_quantity: number | null;
  status: string;
};

export async function getSellerProduct(sellerId: string, productId: string) {
  const { rows } = await dbQuery<Record<string, unknown>>(
    `SELECT ${SELLER_PRODUCT_COLS} FROM marketplace_products WHERE id = $1 AND seller_id = $2`,
    [productId, sellerId],
  );
  if (!rows[0]) return null;
  const { rows: variants } = await dbQuery<SellerVariantRow>(
    `SELECT id::text, sku, title, attributes, price_cents, inventory_quantity, status
       FROM marketplace_product_variants
      WHERE product_id = $1 AND status <> 'archived'
      ORDER BY created_at, id`,
    [productId],
  );
  return { ...rows[0], variants };
}

export type UpdateResult =
  | { ok: true; product: Record<string, unknown>; textChanged: boolean }
  | { ok: false; code: "not_found" | "compare_below_price" | "price_below_cost" };

const toCents = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));

function buildColumns(d: SellerProductUpdate): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length + 2}`);
  };
  if (d.title !== undefined) set("title", d.title);
  if (d.description !== undefined) set("description", d.description);
  if (d.brand !== undefined) set("brand", d.brand);
  if (d.price !== undefined) set("price_cents", toCents(d.price));
  if (d.compare_at_price !== undefined) set("compare_at_price_cents", toCents(d.compare_at_price));
  if (d.shipping_cost !== undefined) set("shipping_cost_cents", toCents(d.shipping_cost));
  if (d.category !== undefined) set("category", d.category ?? "General");
  if (d.taxonomy_node_slug !== undefined) set("taxonomy_node_slug", d.taxonomy_node_slug);
  if (d.status !== undefined) set("status", d.status);
  if (d.stock !== undefined) set("inventory_status", inventoryStatusFor(d.stock));
  if (d.image_urls !== undefined) set("image_url", d.image_urls[0] ?? null);

  const meta: Record<string, unknown> = {};
  if (d.stock !== undefined) meta.available_stock = d.stock;
  if (d.sku !== undefined) meta.sku = d.sku;
  if (d.barcode !== undefined) meta.barcode = d.barcode;
  if (d.image_urls !== undefined) meta.image_urls = d.image_urls;
  if (d.shipping_days_min !== undefined) meta.shipping_days_min = d.shipping_days_min;
  if (d.shipping_days_max !== undefined) meta.shipping_days_max = d.shipping_days_max;
  if (d.courier !== undefined) meta.courier = d.courier;
  if (Object.keys(meta).length > 0) {
    params.push(JSON.stringify(meta));
    sets.push(`metadata = metadata || $${params.length + 2}::jsonb`);
  }
  return { sets, params };
}

async function syncVariants(
  q: TxQuery,
  productId: string,
  currency: string,
  basePriceCents: number | null,
  variants: SellerVariantUpdate[],
): Promise<void> {
  const keepIds = variants.filter((v) => v.id).map((v) => v.id as string);
  await q(
    `UPDATE marketplace_product_variants SET status = 'archived', updated_at = now()
      WHERE product_id = $1 AND status <> 'archived' AND NOT (id = ANY($2::uuid[]))`,
    [productId, keepIds],
  );
  for (const v of variants) {
    const qty = v.inventory_quantity ?? null;
    const status = qty === 0 ? "out_of_stock" : "active";
    const args = [v.sku ?? null, v.title ?? null, JSON.stringify(v.attributes ?? {}), v.price_cents ?? basePriceCents, qty, status];
    if (v.id) {
      await q(
        `UPDATE marketplace_product_variants
            SET sku = $3, title = $4, attributes = $5::jsonb, price_cents = $6, inventory_quantity = $7, status = $8, updated_at = now()
          WHERE id = $1 AND product_id = $2`,
        [v.id, productId, ...args],
      );
    } else {
      await q(
        `INSERT INTO marketplace_product_variants (product_id, currency, sku, title, attributes, price_cents, inventory_quantity, status, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, '{}'::jsonb)`,
        [productId, currency, ...args],
      );
    }
  }
}

export async function updateSellerProduct(sellerId: string, productId: string, d: SellerProductUpdate): Promise<UpdateResult> {
  return withTransaction(async (q) => {
    const { rows } = await q<{ price_cents: number | null; compare_at_price_cents: number | null; currency: string }>(
      `SELECT price_cents, compare_at_price_cents, currency FROM marketplace_products
        WHERE id = $1 AND seller_id = $2 FOR UPDATE`,
      [productId, sellerId],
    );
    const current = rows[0];
    if (!current) return { ok: false, code: "not_found" };

    const price = d.price !== undefined ? toCents(d.price) : current.price_cents;
    const compare = d.compare_at_price !== undefined ? toCents(d.compare_at_price) : current.compare_at_price_cents;
    if (compare != null && compare > 0 && price != null && compare < price) return { ok: false, code: "compare_below_price" };

    const { sets, params } = buildColumns(d);
    let product: Record<string, unknown> | undefined;
    try {
      const res = await q<Record<string, unknown>>(
        `UPDATE marketplace_products SET ${[...sets, "updated_at = now()"].join(", ")}
          WHERE id = $1 AND seller_id = $2
          RETURNING ${SELLER_PRODUCT_COLS}`,
        [productId, sellerId, ...params],
      );
      product = res.rows[0];
    } catch (err) {
      // marketplace_products_price_ge_cost_check: prețul sub cost + transport.
      if ((err as { code?: string })?.code === "23514") return { ok: false, code: "price_below_cost" };
      throw err;
    }
    if (!product) return { ok: false, code: "not_found" };
    if (d.variants) await syncVariants(q, productId, current.currency, price, d.variants);
    return { ok: true, product, textChanged: d.title !== undefined || d.description !== undefined };
  });
}

/** Arhivare (nu ștergere: produsul poate fi în comenzi). */
export async function archiveSellerProduct(sellerId: string, productId: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `UPDATE marketplace_products SET status = 'archived', updated_at = now() WHERE id = $1 AND seller_id = $2`,
    [productId, sellerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Rândul de traducere pentru limba seller-ului (sursa 'seller'). */
export async function upsertSellerProductTranslation(args: {
  productId: string;
  locale: string;
  title: string;
  description: string | null;
  slug: string | null;
}): Promise<void> {
  await dbQuery(
    `INSERT INTO product_translations (product_id, locale, title, description, slug, source)
     VALUES ($1, $2, $3, $4, $5, 'seller')
     ON CONFLICT (product_id, locale) DO UPDATE
       SET title = EXCLUDED.title, description = EXCLUDED.description,
           slug = COALESCE(EXCLUDED.slug, product_translations.slug), source = 'seller'`,
    [args.productId, args.locale, args.title, args.description, args.slug],
  );
}
