/**
 * Catalogul POS: un rând per produs fără variante, un rând per variantă altfel.
 * Stocul `null` = negestionat (nelimitat) — NU se afișează un număr inventat
 * și nu blochează vânzarea (aceeași regulă ca la checkout).
 */
export type PosProduct = {
  /** Cheie unică în UI (produs sau produs:variantă). */
  key: string;
  id: string;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  priceCents: number;
  stock: number | null;
  imageUrl: string | null;
  sku: string | null;
  category: string | null;
};

export type PosProductRow = {
  id: string;
  title: string;
  price_cents: number | string | null;
  category: string | null;
  image_url: string | null;
  metadata: Record<string, unknown> | null;
};

export type PosVariantRow = {
  id: string;
  product_id: string;
  title: string | null;
  sku: string | null;
  price_cents: number | string | null;
  inventory_quantity: number | string | null;
};

function trackedStock(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

export function buildPosCatalog(products: PosProductRow[], variants: PosVariantRow[]): PosProduct[] {
  const byProduct = new Map<string, PosVariantRow[]>();
  for (const v of variants) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);

  return products.flatMap((p): PosProduct[] => {
    const meta = p.metadata ?? {};
    const sku = typeof meta.sku === "string" ? meta.sku : null;
    const base = {
      id: p.id,
      title: p.title,
      imageUrl: p.image_url,
      category: p.category,
      priceCents: Number(p.price_cents) || 0,
    };
    const own = byProduct.get(p.id);
    if (!own?.length) {
      return [{ ...base, key: p.id, variantId: null, variantTitle: null, stock: trackedStock(meta.available_stock), sku }];
    }
    return own.map((v) => ({
      ...base,
      key: `${p.id}:${v.id}`,
      variantId: v.id,
      variantTitle: v.title,
      priceCents: v.price_cents != null && v.price_cents !== "" ? Number(v.price_cents) : base.priceCents,
      stock: trackedStock(v.inventory_quantity),
      sku: v.sku ?? sku,
    }));
  });
}
