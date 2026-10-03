/**
 * Calculul prețului unei comenzi — PUR (fără DB), deci testabil exhaustiv.
 *
 * Reguli (audit shop 2026-09-25):
 *  - prețul vine DOAR din catalog (produs/variantă din DB), niciodată din client;
 *  - dacă produsul are variante active, varianta e obligatorie și trebuie să
 *    aparțină produsului (lookup după id, scopat pe produs);
 *  - stocul disponibil = stoc − cantitățile rezervate de alte comenzi neplătite;
 *    `null` = stoc nelimitat/negestionat.
 */
import { createHash } from "node:crypto";
import type { ShopConfig } from "./config";

export type PricingProduct = {
  id: string;
  title: string;
  priceCents: number | null;
  currency: string;
  /** Stocul la nivel de produs (metadata.available_stock) — null = negestionat. */
  stock: number | null;
  listingType: string;
  purchasable: boolean;
  sellerId?: string | null;
};

export type PricingVariant = {
  id: string;
  productId: string;
  title: string | null;
  priceCents: number | null;
  stock: number | null;
  status: string;
};

export type LineInput = {
  productId: string;
  variantId: string | null;
  quantity: number;
  videoId?: string | null;
};

export type PricedLine = {
  productId: string;
  variantId: string | null;
  title: string;
  unitCents: number;
  quantity: number;
  lineCents: number;
  currency: string;
  videoId: string | null;
  sellerId: string | null;
};

export type PricingErrorCode =
  | "cart_empty"
  | "invalid_quantity"
  | "product_unavailable"
  | "not_purchasable"
  | "variant_required"
  | "variant_unavailable"
  | "insufficient_stock"
  | "mixed_currency";

export class PricingError extends Error {
  constructor(
    public readonly code: PricingErrorCode,
    public readonly productId: string | null = null,
    public readonly available: number | null = null,
  ) {
    super(code);
    this.name = "PricingError";
  }
}

/** Cheia de rezervare: variantă dacă există, altfel produs. */
export function stockKey(productId: string, variantId: string | null): string {
  return variantId ? `v:${variantId}` : `p:${productId}`;
}

const SELLABLE_VARIANT = new Set(["active"]);

export function priceLine(
  input: LineInput,
  product: PricingProduct | undefined,
  variants: PricingVariant[],
  reserved: Map<string, number>,
  config: Pick<ShopConfig, "maxLineQty">,
): PricedLine {
  const qty = input.quantity;
  if (!Number.isInteger(qty) || qty < 1 || qty > config.maxLineQty) {
    throw new PricingError("invalid_quantity", input.productId);
  }
  if (!product || product.priceCents == null || product.priceCents <= 0) {
    throw new PricingError("product_unavailable", input.productId);
  }
  if (!product.purchasable || product.listingType !== "product") {
    throw new PricingError("not_purchasable", product.id);
  }

  const own = variants.filter((v) => v.productId === product.id);
  const sellable = own.filter((v) => SELLABLE_VARIANT.has(v.status));
  let variant: PricingVariant | null = null;
  if (input.variantId) {
    variant = own.find((v) => v.id === input.variantId) ?? null;
    if (!variant || !SELLABLE_VARIANT.has(variant.status)) {
      throw new PricingError("variant_unavailable", product.id);
    }
  } else if (sellable.length > 0) {
    throw new PricingError("variant_required", product.id);
  }

  const unitCents =
    variant && variant.priceCents != null && variant.priceCents > 0 ? variant.priceCents : product.priceCents;
  const stock = variant ? variant.stock : product.stock;
  if (stock != null) {
    const held = reserved.get(stockKey(product.id, variant?.id ?? null)) ?? 0;
    const available = Math.max(0, stock - held);
    if (qty > available) throw new PricingError("insufficient_stock", product.id, available);
  }

  const variantLabel = variant?.title?.trim();
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    title: variantLabel ? `${product.title} — ${variantLabel}` : product.title,
    unitCents,
    quantity: qty,
    lineCents: unitCents * qty,
    currency: product.currency,
    videoId: input.videoId ?? null,
    sellerId: product.sellerId ?? null,
  };
}

export type PricedCart = {
  lines: PricedLine[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  fingerprint: string;
};

export function shippingFor(subtotalCents: number, config: Pick<ShopConfig, "shippingFlatCents" | "freeShippingThresholdCents">): number {
  if (config.freeShippingThresholdCents != null && subtotalCents >= config.freeShippingThresholdCents) return 0;
  return config.shippingFlatCents;
}

/** Amprenta coșului: identică ⇔ aceleași linii, cantități, prețuri și monede. */
export function cartFingerprint(lines: PricedLine[], totalCents: number): string {
  const parts = lines
    .map((l) => `${l.productId}:${l.variantId ?? "-"}:${l.quantity}:${l.unitCents}:${l.currency}`)
    .sort();
  return createHash("sha256").update(`${parts.join("|")}#${totalCents}`).digest("hex").slice(0, 32);
}

export function priceCart(
  inputs: LineInput[],
  products: Map<string, PricingProduct>,
  variants: PricingVariant[],
  reserved: Map<string, number>,
  config: ShopConfig,
): PricedCart {
  if (inputs.length === 0) throw new PricingError("cart_empty");
  // Aceeași variantă pe două linii consumă același stoc: rezervăm progresiv.
  const running = new Map(reserved);
  const lines = inputs.map((input) => {
    const line = priceLine(input, products.get(input.productId), variants, running, config);
    const key = stockKey(line.productId, line.variantId);
    running.set(key, (running.get(key) ?? 0) + line.quantity);
    return line;
  });
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) throw new PricingError("mixed_currency");
  const subtotalCents = lines.reduce((s, l) => s + l.lineCents, 0);
  const shippingCents = shippingFor(subtotalCents, config);
  const totalCents = subtotalCents + shippingCents;
  return {
    lines,
    subtotalCents,
    shippingCents,
    totalCents,
    currency: lines[0].currency,
    fingerprint: cartFingerprint(lines, totalCents),
  };
}
