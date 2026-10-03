/**
 * Validarea editării unui produs de seller (PATCH /api/seller/products/[id]).
 * Toate câmpurile sunt opționale; `variants`, dacă e trimis, e lista COMPLETĂ
 * (cele cu `id` se actualizează, cele fără se adaugă, cele lipsă se arhivează —
 * nu se șterg, pot fi referite de comenzi).
 */
import { z } from "zod";
import { slugify } from "@/lib/merchants/slug";
import { SELLER_PRODUCT_MAX_IMAGES, SELLER_PRODUCT_MAX_VARIANTS } from "./config";

const money = z.coerce.number().finite().nonnegative().max(1_000_000);

export const SellerVariantUpdateSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().trim().max(64).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
  attributes: z.record(z.string(), z.string().max(80)).optional(),
  price_cents: z.number().int().nonnegative().max(100_000_000).optional().nullable(),
  inventory_quantity: z.number().int().nonnegative().max(1_000_000).optional().nullable(),
});
export type SellerVariantUpdate = z.infer<typeof SellerVariantUpdateSchema>;

export const SellerProductUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000).nullable(),
    brand: z.string().trim().max(120).nullable(),
    sku: z.string().trim().max(64).nullable(),
    barcode: z.string().trim().max(64).nullable(),
    price: z.coerce.number().finite().positive().max(1_000_000),
    compare_at_price: money.nullable(),
    stock: z.coerce.number().int().nonnegative().max(1_000_000),
    category: z.string().trim().max(200).nullable(),
    taxonomy_node_slug: z.string().trim().max(120).nullable(),
    image_urls: z.array(z.string().url().max(2048)).max(SELLER_PRODUCT_MAX_IMAGES),
    shipping_cost: z.coerce.number().finite().nonnegative().max(10_000).nullable(),
    shipping_days_min: z.coerce.number().int().nonnegative().max(180).nullable(),
    shipping_days_max: z.coerce.number().int().nonnegative().max(180).nullable(),
    courier: z.enum(["dpd", "fan_courier", "sameday", "cargus", "posta_romana", "gls", "other"]).nullable(),
    status: z.enum(["active", "draft", "archived"]),
    variants: z.array(SellerVariantUpdateSchema).max(SELLER_PRODUCT_MAX_VARIANTS),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "empty_update" })
  .refine(
    (d) => d.shipping_days_min == null || d.shipping_days_max == null || d.shipping_days_max >= d.shipping_days_min,
    { message: "invalid_shipping_days" },
  );
export type SellerProductUpdate = z.infer<typeof SellerProductUpdateSchema>;

/** Slug unic pentru un produs de seller. */
export function sellerProductSlug(title: string, now: number = Date.now()): string {
  return `${slugify(title) || "product"}-${now.toString(36)}`;
}

/** Starea de inventar derivată din stoc. */
export function inventoryStatusFor(stock: number): "in_stock" | "out_of_stock" {
  return stock > 0 ? "in_stock" : "out_of_stock";
}
