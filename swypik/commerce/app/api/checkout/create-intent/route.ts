/**
 * POST /api/checkout/create-intent — pornește plata pentru coșul curent.
 *
 * Corpul NU mai conține produse/prețuri: comanda se construiește din coșul din
 * DB (`lib/shop/checkout.ts`). Răspunsurile de eroare poartă doar `code`
 * (tradus în client), niciodată text hardcodat.
 */
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getOrCreateCart } from "@/lib/cart/session";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/rate-limit";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { PaymentInProgressError, createOrReuseCheckout } from "@/lib/shop/checkout";
import { PricingError } from "@/lib/shop/pricing";
import { ShopCheckoutSchema } from "@/lib/shop/schemas";
import { shopPaymentsConfigured } from "@/lib/shop/payments-config";

const NO_STORE = { "Cache-Control": "private, no-store" } as Record<string, string>;

function fail(code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, code, ...extra }, { status, headers: NO_STORE });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

export async function POST(req: Request) {
  try {
    const user = await getAuthUser().catch(() => null);
    if (!user?.userId) return fail("auth_required", 401);

    const rl = await rateLimit("checkout", `u:${user.userId}`, { limit: 10, window: 60 });
    if (!rl.success) return fail("rate_limited", 429);

    const parsed = parseBody(ShopCheckoutSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return fail("validation_error", 400);

    // Chei Stripe placeholder → răspuns imediat, fără comandă creată și marcată „failed”.
    if (!shopPaymentsConfigured()) return fail("payments_unavailable", 503);

    const { isUserFraudBlocked } = await import("@/lib/risk/user-block");
    if (await isUserFraudBlocked(user.userId)) {
      logger.warn({ uid: user.userId }, "[checkout] fraud-blocked user attempted checkout");
      return fail("account_blocked", 403);
    }

    const cart = await getOrCreateCart({ create: false });
    if (!cart) return fail("cart_empty", 400);

    const ctx = {
      cartId: cart.cartId,
      buyer: { userId: user.userId, email: user.email || parsed.data.email || null },
      ipCountry: (req.headers.get("cf-ipcountry") || "").trim().toUpperCase() || null,
      userAgent: (req.headers.get("user-agent") || "").slice(0, 200) || null,
      nativeApp: parsed.data.client === "app",
    };
    if (!ctx.buyer.email) return fail("email_required", 400);

    let result;
    try {
      result = await createOrReuseCheckout(ctx);
    } catch (err) {
      // Două cereri simultane pe același coș: a doua pică pe indexul unic
      // (o singură comandă pending per coș) — reluarea o găsește și o refolosește.
      if (!isUniqueViolation(err)) throw err;
      result = await createOrReuseCheckout(ctx);
    }

    return NextResponse.json(
      {
        success: true,
        clientSecret: result.clientSecret,
        orderId: result.orderId,
        orderLookupToken: result.orderLookupToken,
        subtotalCents: result.subtotalCents,
        shippingCents: result.shippingCents,
        totalCents: result.totalCents,
        currency: result.currency,
        reused: result.reused,
      },
      { headers: NO_STORE },
    );
  } catch (error: unknown) {
    if (error instanceof PaymentInProgressError) {
      return fail(error.code, 409, { orderId: error.orderId });
    }
    if (error instanceof PricingError) {
      const status = error.code === "insufficient_stock" ? 409 : 400;
      return fail(error.code, status, { productId: error.productId, available: error.available });
    }
    const type = (error as { type?: string } | null)?.type ?? "";
    logger.error({ err: error, ip: clientIp(req) }, "[checkout.create-intent] failed");
    if (type === "StripeAuthenticationError" || type === "StripePermissionError") {
      return fail("payments_unavailable", 503);
    }
    return fail("checkout_failed", 500);
  }
}
