import { withErrorHandling } from "@/lib/api-handler";
/**
 * PATCH /api/cart/items/[id]  body { quantity }
 * DELETE /api/cart/items/[id]
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOrCreateCart } from "@/lib/cart/session";
import { loadCart } from "@/lib/shop/cart";
import { getShopConfig } from "@/lib/shop/config";
import { CartItemPatchSchema, parseBody } from "@/lib/validation/schemas";
import { rateLimit } from "@/lib/security/rate-limit";

const NO_STORE = { "Cache-Control": "private, no-store" } as Record<string, string>;

async function ownItem(cartId: string, itemId: string): Promise<boolean> {
  const { rows } = await dbQuery(`SELECT 1 FROM cart_items WHERE id = $1 AND cart_id = $2 LIMIT 1`, [itemId, cartId]);
  return rows.length > 0;
}

async function PATCH_impl(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cart = await getOrCreateCart();
  if (!cart) return NextResponse.json({ error: "no_cart" }, { status: 404, headers: NO_STORE });
  const rl = await rateLimit("cartItems", cart.cartId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  if (!(await ownItem(cart.cartId, id))) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const rawBody = await req.json().catch(() => ({}));
  const parsed = parseBody(CartItemPatchSchema, rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ code: "validation_error", issues: parsed.issues }, { status: 400, headers: NO_STORE });
  }
  const quantity = Math.min(parsed.data.quantity, getShopConfig().maxLineQty);
  if (quantity === 0) {
    await dbQuery(`DELETE FROM cart_items WHERE id = $1`, [id]);
  } else {
    await dbQuery(`UPDATE cart_items SET quantity = $1, updated_at = now() WHERE id = $2`, [quantity, id]);
  }
  return NextResponse.json({ success: true, ...(await loadCart(cart.cartId, cart.currency)) }, { headers: NO_STORE });
}

async function DELETE_impl(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cart = await getOrCreateCart();
  if (!cart) return NextResponse.json({ error: "no_cart" }, { status: 404, headers: NO_STORE });
  const rl = await rateLimit("cartItems", cart.cartId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  if (!(await ownItem(cart.cartId, id))) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  await dbQuery(`DELETE FROM cart_items WHERE id = $1`, [id]);
  return NextResponse.json({ success: true, ...(await loadCart(cart.cartId, cart.currency)) }, { headers: NO_STORE });
}

export const PATCH = withErrorHandling(PATCH_impl);
export const DELETE = withErrorHandling(DELETE_impl);
