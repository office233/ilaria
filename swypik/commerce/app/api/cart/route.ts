import { withErrorHandling } from "@/lib/api-handler";
/**
 * GET  /api/cart            → returns active cart for user (auth) or anon (cookie).
 * POST /api/cart/items      → handled by /items route.
 * DELETE /api/cart          → clear all items in active cart.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { buildCartCookie, getOrCreateCart } from "@/lib/cart/session";
import { loadCart } from "@/lib/shop/cart";
import { rateLimit } from "@/lib/security/rate-limit";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";

const NO_STORE = { "Cache-Control": "private, no-store" } as Record<string, string>;

async function GET_impl() {
  const cart = await getOrCreateCart({ create: false });
  if (!cart) {
    return NextResponse.json({ items: [], subtotalCents: 0, currency: DEFAULT_CURRENCY }, { headers: NO_STORE });
  }
  const res = NextResponse.json(await loadCart(cart.cartId, cart.currency), { headers: NO_STORE });
  if (cart.anonToken && !cart.userId) {
    res.headers.append("Set-Cookie", buildCartCookie(cart.anonToken));
  }
  return res;
}

async function DELETE_impl() {
  const cart = await getOrCreateCart();
  if (cart) {
    const rl = await rateLimit("cartClear", cart.cartId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
    await dbQuery(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.cartId]);
  }
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}

export const GET = withErrorHandling(GET_impl);
export const DELETE = withErrorHandling(DELETE_impl);
