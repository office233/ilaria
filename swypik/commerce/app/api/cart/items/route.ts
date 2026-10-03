/**
 * POST /api/cart/items → adaugă un produs (și varianta lui) în coșul activ.
 * Body: { productId, variantId?, quantity?, videoId? }
 *
 * Prețul, titlul și imaginea vin EXCLUSIV din catalog. Varianta e căutată după
 * id și obligatoriu în cadrul produsului; produsele cu variante cer varianta.
 */
import { NextResponse } from "next/server";
import { buildCartCookie, getOrCreateCart } from "@/lib/cart/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";
import { addToCart, loadCart } from "@/lib/shop/cart";
import { getShopConfig } from "@/lib/shop/config";
import { ShopCartAddSchema } from "@/lib/shop/schemas";
import { isUuid } from "@/lib/validation/uuid";

const NO_STORE = { "Cache-Control": "private, no-store" } as Record<string, string>;

const STATUS_BY_ERROR = {
  product_not_found: 404,
  not_purchasable: 400,
  variant_required: 400,
  variant_unavailable: 400,
} as const;

export async function POST(req: Request) {
  try {
    const rl = await rateLimit("cartItems", getClientIP(req));
    if (!rl.success) return NextResponse.json({ code: "rate_limited" }, { status: 429, headers: NO_STORE });

    const parsed = parseBody(ShopCartAddSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json({ code: "validation_error", issues: parsed.issues }, { status: 400, headers: NO_STORE });
    }

    const cart = await getOrCreateCart({ create: true });
    if (!cart) return NextResponse.json({ code: "cart_unavailable" }, { status: 500, headers: NO_STORE });

    const result = await addToCart({
      cartId: cart.cartId,
      productId: parsed.data.productId,
      variantId: parsed.data.variantId ?? null,
      quantity: parsed.data.quantity,
      videoId: isUuid(parsed.data.videoId) ? parsed.data.videoId : null,
      maxLineQty: getShopConfig().maxLineQty,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, code: result.error }, { status: STATUS_BY_ERROR[result.error], headers: NO_STORE });
    }

    const snapshot = await loadCart(cart.cartId, cart.currency || DEFAULT_CURRENCY);
    const res = NextResponse.json({ success: true, ...snapshot }, { headers: NO_STORE });
    if (cart.anonToken && !cart.userId) res.headers.append("Set-Cookie", buildCartCookie(cart.anonToken));
    return res;
  } catch (err) {
    logger.error({ err }, "[cart.items] add failed");
    return NextResponse.json({ code: "cart_add_failed" }, { status: 500, headers: NO_STORE });
  }
}
