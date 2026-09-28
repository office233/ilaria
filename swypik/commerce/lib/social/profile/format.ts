/** Mapări pure pentru profilul public (linkuri, produse promovate, valori). */

export type CreatorLink = { label: string; url: string };

export type PromotedProduct = {
  id: string;
  title: string | null;
  imageUrl: string | null;
  priceCents: number | null;
  currency: string;
  productUrl: string | null;
};

export type PromotedProductRow = {
  id: string;
  title: string | null;
  image_url: string | null;
  price_cents: number | string | null;
  currency: string | null;
  product_url: string | null;
};

const MAX_LINKS = 8;

export function toNonNegativeInt(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

export function emptyToNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** Linkurile publice: doar http(s), fără duplicate, maxim 8. Eticheta „website" e o cheie, tradusă în UI. */
export function buildCreatorLinks(websiteUrl: string | null, socialLinks: Record<string, unknown> | null): CreatorLink[] {
  const links: CreatorLink[] = [];
  const seen = new Set<string>();
  const push = (label: string, url: unknown) => {
    const value = String(url ?? "").trim();
    if (!value || seen.has(value) || !/^https?:\/\//i.test(value)) return;
    seen.add(value);
    links.push({ label, url: value });
  };
  push("website", websiteUrl);
  if (socialLinks && typeof socialLinks === "object") {
    for (const [key, value] of Object.entries(socialLinks)) {
      const label = key.trim();
      if (label) push(label, value);
    }
  }
  return links.slice(0, MAX_LINKS);
}

export function mapPromotedProductRow(row: PromotedProductRow): PromotedProduct {
  return {
    id: row.id,
    title: emptyToNull(row.title),
    imageUrl: emptyToNull(row.image_url),
    priceCents: row.price_cents === null ? null : toNonNegativeInt(row.price_cents),
    currency: String(row.currency ?? "RON").trim().toUpperCase() || "RON",
    productUrl: emptyToNull(row.product_url),
  };
}
