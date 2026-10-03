/**
 * Modelul formularului de produs (creare + editare) — pur, fără React, ca să fie
 * testat: produs din API → ciornă, ciornă → payload POST/PATCH, validare.
 */

export const COURIERS = ["dpd", "fan_courier", "sameday", "cargus", "posta_romana", "gls", "other"] as const;
export type Courier = (typeof COURIERS)[number];
export const PRODUCT_STATUSES = ["active", "draft", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export type VariantDraft = { id?: string; title: string; sku: string; price: string; stock: string };

export type ProductDraft = {
  title: string;
  description: string;
  brand: string;
  sku: string;
  category: string;
  taxonomySlug: string;
  images: string[];
  price: string;
  compareAt: string;
  stock: string;
  shippingCost: string;
  shippingDaysMin: string;
  shippingDaysMax: string;
  courier: Courier | "";
  status: ProductStatus;
  variants: VariantDraft[];
};

export type ApiProduct = {
  id: string;
  title: string;
  description?: string | null;
  brand?: string | null;
  category?: string | null;
  taxonomy_node_slug?: string | null;
  price_cents: number | null;
  compare_at_price_cents?: number | null;
  shipping_cost_cents?: number | null;
  currency?: string;
  status: string;
  inventory_status?: string;
  image_url?: string | null;
  metadata?: Record<string, unknown> | null;
  variants?: Array<{ id: string; title: string | null; sku: string | null; price_cents: number | null; inventory_quantity: number | null }>;
};

export function emptyDraft(): ProductDraft {
  return {
    title: "", description: "", brand: "", sku: "", category: "", taxonomySlug: "", images: [],
    price: "", compareAt: "", stock: "", shippingCost: "", shippingDaysMin: "", shippingDaysMax: "",
    courier: "", status: "active", variants: [],
  };
}

const str = (v: unknown) => (v == null ? "" : String(v));
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

export function draftFromProduct(p: ApiProduct): ProductDraft {
  const m = p.metadata ?? {};
  const images = Array.isArray(m.image_urls) ? (m.image_urls as unknown[]).map(String) : p.image_url ? [p.image_url] : [];
  const courier = COURIERS.includes(m.courier as Courier) ? (m.courier as Courier) : "";
  return {
    title: p.title,
    description: str(p.description),
    brand: str(p.brand),
    sku: str(m.sku),
    category: str(p.category),
    taxonomySlug: str(p.taxonomy_node_slug),
    images,
    price: fromCents(p.price_cents),
    compareAt: fromCents(p.compare_at_price_cents),
    stock: str(m.available_stock ?? 0),
    shippingCost: fromCents(p.shipping_cost_cents),
    shippingDaysMin: str(m.shipping_days_min),
    shippingDaysMax: str(m.shipping_days_max),
    courier,
    status: (PRODUCT_STATUSES as readonly string[]).includes(p.status) ? (p.status as ProductStatus) : "active",
    variants: (p.variants ?? []).map((v) => ({
      id: v.id,
      title: str(v.title),
      sku: str(v.sku),
      price: fromCents(v.price_cents),
      stock: str(v.inventory_quantity),
    })),
  };
}

const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
const int = (s: string) => (s.trim() === "" ? null : Math.trunc(Number(s)));
const cents = (s: string) => {
  const n = num(s);
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100);
};

export type DraftError = "title" | "price" | "stock" | "compareAt" | "shippingDays" | "variant";

export function validateDraft(d: ProductDraft): DraftError | null {
  if (d.title.trim().length < 3) return "title";
  const price = num(d.price);
  if (price == null || !Number.isFinite(price) || price <= 0) return "price";
  const stock = int(d.stock);
  if (stock == null || !Number.isFinite(stock) || stock < 0) return "stock";
  const compare = num(d.compareAt);
  if (compare != null && (!Number.isFinite(compare) || compare < price)) return "compareAt";
  const min = int(d.shippingDaysMin);
  const max = int(d.shippingDaysMax);
  if (min != null && max != null && max < min) return "shippingDays";
  for (const v of d.variants) {
    const vp = num(v.price);
    const vs = int(v.stock);
    if (!v.title.trim() || (vp != null && !(vp >= 0)) || (vs != null && !(vs >= 0))) return "variant";
  }
  return null;
}

function variantsPayload(d: ProductDraft) {
  return d.variants.map((v) => ({
    ...(v.id ? { id: v.id } : {}),
    title: v.title.trim(),
    sku: v.sku.trim() || null,
    price_cents: cents(v.price),
    inventory_quantity: int(v.stock),
  }));
}

/** PATCH — lista completă a câmpurilor editabile (variantele = lista completă). */
export function draftToUpdatePayload(d: ProductDraft) {
  return {
    title: d.title.trim(),
    description: d.description.trim() || null,
    brand: d.brand.trim() || null,
    sku: d.sku.trim() || null,
    price: num(d.price),
    compare_at_price: num(d.compareAt),
    stock: int(d.stock),
    category: d.category.trim() || null,
    taxonomy_node_slug: d.taxonomySlug.trim() || null,
    image_urls: d.images,
    shipping_cost: num(d.shippingCost),
    shipping_days_min: int(d.shippingDaysMin),
    shipping_days_max: int(d.shippingDaysMax),
    courier: d.courier || null,
    status: d.status,
    variants: variantsPayload(d),
  };
}

/** POST — schema de creare nu acceptă null: câmpurile goale lipsesc. */
export function draftToCreatePayload(d: ProductDraft, currency: string) {
  const u = draftToUpdatePayload(d);
  const out: Record<string, unknown> = { currency };
  for (const [k, v] of Object.entries(u)) {
    if (k === "status" || v == null || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  if (Array.isArray(out.variants)) {
    out.variants = (out.variants as Array<Record<string, unknown>>).map((v) =>
      Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)),
    );
  }
  return out;
}

/** Ce primește seller-ul dintr-o vânzare la prețul dat (după comisionul platformei). */
export function netAfterCommission(priceCents: number, commissionBps: number): number {
  return priceCents - Math.round((priceCents * commissionBps) / 10_000);
}
