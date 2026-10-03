/**
 * Coșul cumpărătorului: citire (cu prețul CURENT din catalog) și adăugare
 * validată (produs + variantă scopată pe produs). Prețul din `cart_items` e
 * doar o fotografie de la adăugare; afișarea și checkout-ul folosesc catalogul.
 */
import { dbQuery } from "@/lib/db";
import { UUID_RE } from "@/lib/validation/uuid";

export type CartLine = {
  id: string;
  productId: string;
  variantId: string | null;
  variantTitle: string | null;
  title: string;
  image: string | null;
  quantity: number;
  priceCents: number;
  currency: string;
  /** Stoc rămas (null = negestionat). */
  stock: number | null;
  purchasable: boolean;
  videoId: string | null;
};

export type CartSnapshot = { items: CartLine[]; subtotalCents: number; currency: string };

type Row = {
  id: string;
  product_id: string;
  variant_id: string | null;
  variant_title: string | null;
  title: string;
  quantity: number;
  unit_amount_cents: number;
  currency: string;
  image: string | null;
  mp_price: number | null;
  v_price: number | null;
  v_stock: number | null;
  p_stock: string | null;
  purchasable: boolean | null;
  video_id: string | null;
};

export async function loadCart(cartId: string, fallbackCurrency: string): Promise<CartSnapshot> {
  const { rows } = await dbQuery<Row>(
    `SELECT ci.id::text AS id,
            COALESCE(ci.marketplace_product_id::text, ci.external_product_id) AS product_id,
            ci.marketplace_variant_id::text AS variant_id,
            v.title AS variant_title,
            COALESCE(mp.title, ci.title) AS title,
            ci.quantity, ci.unit_amount_cents,
            COALESCE(mp.currency, ci.currency) AS currency,
            COALESCE(ci.metadata->>'image', mp.image_url) AS image,
            mp.price_cents AS mp_price,
            v.price_cents AS v_price,
            v.inventory_quantity AS v_stock,
            NULLIF(mp.metadata->>'available_stock', '') AS p_stock,
            (mp.status = 'active' AND mp.effective_label = 'safe'
              AND COALESCE(mp.listing_type, 'product') = 'product'
              AND (v.id IS NULL OR v.status = 'active')) AS purchasable,
            ci.video_id::text AS video_id
       FROM cart_items ci
       LEFT JOIN marketplace_products mp ON mp.id = ci.marketplace_product_id
       LEFT JOIN marketplace_product_variants v
         ON v.id = ci.marketplace_variant_id AND v.product_id = ci.marketplace_product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.created_at`,
    [cartId],
  );
  const items = rows.map((r): CartLine => {
    const live = r.v_price != null && r.v_price > 0 ? r.v_price : r.mp_price;
    const stockRaw = r.variant_id ? r.v_stock : r.p_stock != null ? Number(r.p_stock) : null;
    return {
      id: r.id,
      productId: r.product_id,
      variantId: r.variant_id,
      variantTitle: r.variant_title,
      title: r.title,
      image: r.image,
      quantity: Number(r.quantity),
      priceCents: Number(live ?? r.unit_amount_cents) || 0,
      currency: String(r.currency || fallbackCurrency).trim().toUpperCase(),
      stock: stockRaw != null && Number.isFinite(Number(stockRaw)) ? Number(stockRaw) : null,
      purchasable: Boolean(r.purchasable),
      videoId: r.video_id,
    };
  });
  const subtotalCents = items.filter((i) => i.purchasable).reduce((s, i) => s + i.priceCents * i.quantity, 0);
  return { items, subtotalCents, currency: items[0]?.currency ?? fallbackCurrency };
}

export type AddToCartInput = {
  cartId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  videoId: string | null;
  maxLineQty: number;
};

export type AddToCartError = "product_not_found" | "not_purchasable" | "variant_required" | "variant_unavailable";

type ResolvedProduct = {
  id: string;
  title: string;
  price_cents: number | null;
  currency: string;
  image_url: string | null;
  purchasable: boolean;
  has_variants: boolean;
};

/** Validează produsul/varianta și face upsert pe linia din coș. */
export async function addToCart(input: AddToCartInput): Promise<{ ok: true } | { ok: false; error: AddToCartError }> {
  if (!UUID_RE.test(input.productId)) return { ok: false, error: "product_not_found" };
  const { rows } = await dbQuery<ResolvedProduct>(
    `SELECT p.id::text AS id, p.title, p.price_cents, p.currency, p.image_url,
            (p.status = 'active' AND p.effective_label = 'safe' AND COALESCE(p.is_adult, false) = false
              AND COALESCE(p.listing_type, 'product') = 'product' AND COALESCE(p.price_cents, 0) > 0) AS purchasable,
            EXISTS (SELECT 1 FROM marketplace_product_variants v WHERE v.product_id = p.id AND v.status = 'active') AS has_variants
       FROM marketplace_products p WHERE p.id = $1::uuid LIMIT 1`,
    [input.productId],
  );
  const product = rows[0];
  if (!product) return { ok: false, error: "product_not_found" };
  if (!product.purchasable) return { ok: false, error: "not_purchasable" };

  let unitCents = Number(product.price_cents);
  if (input.variantId) {
    const { rows: vRows } = await dbQuery<{ id: string; price_cents: number | null }>(
      `SELECT id::text AS id, price_cents FROM marketplace_product_variants
        WHERE id = $1::uuid AND product_id = $2::uuid AND status = 'active' LIMIT 1`,
      [input.variantId, product.id],
    );
    if (!vRows[0]) return { ok: false, error: "variant_unavailable" };
    if (vRows[0].price_cents != null && vRows[0].price_cents > 0) unitCents = Number(vRows[0].price_cents);
  } else if (product.has_variants) {
    return { ok: false, error: "variant_required" };
  }

  // Upsert atomic pe indexul unic parțial (cart_id, external_product_id, variantă).
  await dbQuery(
    `INSERT INTO cart_items
       (cart_id, external_product_id, external_variant_id, marketplace_product_id, marketplace_variant_id,
        title, quantity, currency, unit_amount_cents, video_id, metadata)
     VALUES ($1, $2::text, $3::text, $2::text::uuid, $3::text::uuid, $4, $5, $6, $7, $8::text::uuid, $9::jsonb)
     ON CONFLICT (cart_id, external_product_id, COALESCE(external_variant_id, ''))
       WHERE (metadata->>'mergeable') = 'true'
     DO UPDATE SET
       quantity = LEAST($10::int, cart_items.quantity + EXCLUDED.quantity),
       unit_amount_cents = EXCLUDED.unit_amount_cents,
       video_id = COALESCE(EXCLUDED.video_id, cart_items.video_id),
       updated_at = now()`,
    [
      input.cartId,
      product.id,
      input.variantId,
      product.title,
      Math.min(input.quantity, input.maxLineQty),
      product.currency,
      unitCents,
      input.videoId,
      JSON.stringify({ mergeable: true, image: product.image_url }),
      input.maxLineQty,
    ],
  );
  await dbQuery(`UPDATE carts SET updated_at = now() WHERE id = $1`, [input.cartId]);
  return { ok: true };
}
