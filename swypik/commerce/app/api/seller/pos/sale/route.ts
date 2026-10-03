import { NextResponse } from "next/server";
import { z } from "zod";
import { withTransaction, type TxQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { nextSellerSequence } from "@/lib/seller/sequences";
import { formatReceiptNumber, toCents } from "@/lib/seller/invoicing";
import { sellerCurrency } from "@/lib/seller/config";

export const dynamic = "force-dynamic";

const SaleLineSchema = z.object({
  id: z.string().uuid(),
  /** Varianta vândută (mărime/culoare) — stocul se scade pe variantă. */
  variantId: z.string().uuid().optional(),
  title: z.string().trim().max(200).optional(),
  quantity: z.coerce.number().int().min(1).max(10_000),
  /** Pret unitar cu TVA, in unitatea monedei. */
  price: z.coerce.number().min(0).max(1_000_000),
});

const PosSaleSchema = z.object({
  items: z.array(SaleLineSchema).min(1),
  paymentMethod: z.enum(["cash", "card"]),
});

type SaleLine = z.infer<typeof SaleLineSchema>;

class SaleLineError extends Error {
  constructor(
    readonly code: "product_not_found" | "insufficient_stock" | "variant_required",
    readonly productId: string,
  ) {
    super(code);
  }
}

/**
 * Stocul negestionat (NULL / cheie lipsă) = nelimitat, exact ca la checkout:
 * vânzarea trece, nimic nu se scade. Stocul gestionat se scade atomic doar dacă
 * acoperă cantitatea (WHERE ... >= qty) — două bonuri concurente nu pot vinde
 * peste stoc.
 */
async function sellLine(q: TxQuery, sellerId: string, item: SaleLine): Promise<string> {
  if (item.variantId) {
    const { rows } = await q<{ title: string | null; product_title: string | null }>(
      `UPDATE marketplace_product_variants v
          SET inventory_quantity = CASE WHEN v.inventory_quantity IS NULL THEN NULL ELSE v.inventory_quantity - $1 END,
              status = CASE WHEN v.inventory_quantity IS NOT NULL AND v.inventory_quantity - $1 <= 0
                            THEN 'out_of_stock' ELSE v.status END,
              updated_at = now()
         FROM marketplace_products p
        WHERE v.id = $2 AND v.product_id = $3 AND p.id = v.product_id AND p.seller_id = $4
          AND v.status IN ('active', 'out_of_stock')
          AND (v.inventory_quantity IS NULL OR v.inventory_quantity >= $1)
        RETURNING v.title, p.title AS product_title`,
      [item.quantity, item.variantId, item.id, sellerId],
    );
    if (rows[0]) return [rows[0].product_title, rows[0].title].filter(Boolean).join(" — ");
    const { rows: owned } = await q<{ id: string }>(
      `SELECT v.id FROM marketplace_product_variants v JOIN marketplace_products p ON p.id = v.product_id
        WHERE v.id = $1 AND v.product_id = $2 AND p.seller_id = $3`,
      [item.variantId, item.id, sellerId],
    );
    throw new SaleLineError(owned.length === 0 ? "product_not_found" : "insufficient_stock", item.id);
  }

  const { rows } = await q<{ title: string }>(
    `UPDATE marketplace_products
        SET metadata = CASE
              WHEN NULLIF(metadata->>'available_stock', '') IS NULL THEN metadata
              ELSE jsonb_set(metadata, '{available_stock}', to_jsonb((metadata->>'available_stock')::numeric - $1))
            END,
            inventory_status = CASE
              WHEN NULLIF(metadata->>'available_stock', '') IS NOT NULL
                   AND (metadata->>'available_stock')::numeric - $1 <= 0
              THEN 'out_of_stock' ELSE inventory_status END,
            updated_at = now()
      WHERE id = $2 AND seller_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM marketplace_product_variants v
           WHERE v.product_id = marketplace_products.id AND v.status IN ('active', 'out_of_stock'))
        AND (NULLIF(metadata->>'available_stock', '') IS NULL
             OR (metadata->>'available_stock')::numeric >= $1)
      RETURNING title`,
    [item.quantity, item.id, sellerId],
  );
  if (rows[0]) return rows[0].title;
  // Distingem „nu există / nu-i aparține” de „are variante” și de „stoc insuficient”.
  const { rows: owned } = await q<{ id: string }>(
    `SELECT id FROM marketplace_products WHERE id = $1 AND seller_id = $2`,
    [item.id, sellerId],
  );
  if (owned.length === 0) throw new SaleLineError("product_not_found", item.id);
  const { rows: variants } = await q<{ id: string }>(
    `SELECT id FROM marketplace_product_variants WHERE product_id = $1 AND status IN ('active', 'out_of_stock') LIMIT 1`,
    [item.id],
  );
  throw new SaleLineError(variants.length > 0 ? "variant_required" : "insufficient_stock", item.id);
}

/**
 * Vanzare la casa: scade stocul SI persista bonul, in aceeasi tranzactie.
 */
export const POST = withErrorHandling(async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("sellerPos", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = parseBody(PosSaleSchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    // Codul e stabil (nu textul brut de la zod) — clientul îl traduce.
    return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  }
  const { items, paymentMethod } = parsed.data;
  const totalCents = items.reduce((sum, i) => sum + toCents(i.price) * i.quantity, 0);
  const currency = sellerCurrency();

  let sale: { id: string; receipt_number: string; created_at: string };
  try {
    sale = await withTransaction(async (q) => {
      const lines: Array<SaleLine & { title: string }> = [];
      for (const item of items) {
        const title = await sellLine(q, sellerId, item);
        lines.push({ ...item, title: title || item.title || "" });
      }

      const now = new Date();
      const seq = await nextSellerSequence(q, sellerId, "pos_receipt", now.toISOString().slice(0, 10));
      const { rows } = await q<{ id: string; receipt_number: string; created_at: string }>(
        `INSERT INTO seller_pos_sales (seller_id, receipt_number, items, total_cents, payment_method, currency)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING id, receipt_number, created_at`,
        [sellerId, formatReceiptNumber(now, seq), JSON.stringify(lines), totalCents, paymentMethod, currency],
      );
      return rows[0];
    });
  } catch (err) {
    if (err instanceof SaleLineError) {
      const status = err.code === "product_not_found" ? 404 : 409;
      return NextResponse.json({ success: false, error: err.code, productId: err.productId }, { status });
    }
    throw err;
  }

  return NextResponse.json(
    {
      success: true,
      saleId: sale.id,
      receiptNumber: sale.receipt_number,
      date: sale.created_at,
      totalCents,
      currency,
      paymentMethod,
    },
    { status: 201 },
  );
});
