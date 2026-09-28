/**
 * Shared Cart types used across ChatInterface and ProductPage.
 * 
 * Key design decisions:
 * - Cart key is `${pgId}:${skuId || "base"}` to properly separate variants
 * - Snapshots (title, image, price) are stored for UI only — never sent to checkout
 * - Checkout only sends productId + skuId + quantity + optional videoId (server resolves attribution)
 */

import type { Product } from "./product";

/** Stored in localStorage as aicv_cart */
export type CartItem = {
  product: Product;
  qty: number;
};

/** Build unique cart key for variant deduplication */
export function cartItemKey(item: CartItem): string {
  return `${item.product.id}:${item.product.skuId || "base"}`;
}

/** Checkout payload — only these fields are sent to /api/cart */
export type CheckoutPayload = {
  products: Array<{
    productId: string;
    skuId?: string;
    videoId?: string;
    quantity: number;
  }>;
};

/** Build checkout payload from cart items */
export function buildCheckoutPayload(items: CartItem[]): CheckoutPayload {
  return {
    products: items.map((item) => ({
      productId: item.product.id,
      skuId: item.product.skuId || undefined,
      videoId: item.product.videoId || undefined,
      quantity: item.qty,
    })),
  };
}

/** Merge a product into existing cart, properly handling variant keys */
export function mergeIntoCart(cart: CartItem[], product: Product, quantity: number = 1): CartItem[] {
  const newKey = `${product.id}:${product.skuId || "base"}`;
  const idx = cart.findIndex((item) => cartItemKey(item) === newKey);
  if (idx >= 0) {
    const next = [...cart];
    next[idx] = { ...next[idx], qty: Math.min(10, next[idx].qty + quantity) };
    return next;
  }
  return [...cart, { product, qty: Math.min(10, quantity) }];
}
