import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/checkout/create-intent: auth obligatoriu, comanda se construiește
// din coșul din DB (lib/shop/checkout mock-uit aici), câmpurile moștenite din
// corp (produse, prețuri, SWYP) sunt ignorate, erorile au doar `code`.

const getAuthUser = vi.fn();
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: () => getAuthUser() }));

const getOrCreateCart = vi.fn();
vi.mock("@/lib/cart/session", () => ({ getOrCreateCart: (o: unknown) => getOrCreateCart(o) }));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 10 })),
}));
vi.mock("@/lib/rate-limit", () => ({ clientIp: () => "127.0.0.1" }));

const isUserFraudBlocked = vi.fn(async () => false);
vi.mock("@/lib/risk/user-block", () => ({ isUserFraudBlocked: () => isUserFraudBlocked() }));

const createOrReuseCheckout = vi.fn();
vi.mock("@/lib/shop/checkout", () => {
  class PaymentInProgressError extends Error {
    readonly code = "payment_in_progress";
    constructor(public readonly orderId: string) {
      super("payment_in_progress");
    }
  }
  return { PaymentInProgressError, createOrReuseCheckout: (c: unknown) => createOrReuseCheckout(c) };
});

const shopPaymentsConfigured = vi.fn(() => true);
vi.mock("@/lib/shop/payments-config", () => ({
  shopPaymentsConfigured: () => shopPaymentsConfigured(),
}));

import { POST } from "@/app/api/checkout/create-intent/route";
import { PricingError } from "@/lib/shop/pricing";
import { PaymentInProgressError } from "@/lib/shop/checkout";

const USER = { userId: "user-1", email: "ana@example.com", role: "shopper", sellerId: null, isAdmin: false };
const RESULT = {
  orderId: "order-1",
  orderLookupToken: "tok",
  clientSecret: "secret",
  subtotalCents: 4999,
  shippingCents: 0,
  totalCents: 4999,
  currency: "RON",
  reused: false,
};

function req(body: unknown): Request {
  return new Request("http://localhost/api/checkout/create-intent", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ipcountry": "ro" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(USER);
  getOrCreateCart.mockResolvedValue({ cartId: "cart-1", userId: "user-1", anonToken: null, currency: "RON" });
  createOrReuseCheckout.mockResolvedValue(RESULT);
  isUserFraudBlocked.mockResolvedValue(false);
  shopPaymentsConfigured.mockReturnValue(true);
});

describe("POST /api/checkout/create-intent", () => {
  it("requires login", async () => {
    getAuthUser.mockResolvedValue({ ...USER, userId: null });
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth_required");
    expect(createOrReuseCheckout).not.toHaveBeenCalled();
  });

  it("builds the checkout from the server cart with the buyer id + email", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true, clientSecret: "secret", totalCents: 4999, orderId: "order-1" });
    expect(createOrReuseCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ cartId: "cart-1", buyer: { userId: "user-1", email: "ana@example.com" }, ipCountry: "RO" }),
    );
  });

  it("ignores client-sent products, prices and legacy SWYP fields", async () => {
    await POST(req({ products: [{ productId: "x", quantity: 9, priceCents: 1 }], swypCents: 5000, useSwyp: true }));
    const arg = createOrReuseCheckout.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["buyer", "cartId", "ipCountry", "nativeApp", "userAgent"]);
  });

  it("uses the body email only when the account has none, and requires one", async () => {
    getAuthUser.mockResolvedValue({ ...USER, email: null });
    const missing = await POST(req({}));
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("email_required");

    await POST(req({ email: "phone-user@example.com" }));
    expect(createOrReuseCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ buyer: { userId: "user-1", email: "phone-user@example.com" } }),
    );
  });

  it("returns cart_empty when there is no cart", async () => {
    getOrCreateCart.mockResolvedValue(null);
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("cart_empty");
  });

  it("maps pricing errors to codes (409 for stock)", async () => {
    createOrReuseCheckout.mockRejectedValue(new PricingError("insufficient_stock", "p-1", 2));
    const res = await POST(req({}));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: "insufficient_stock", productId: "p-1", available: 2 });

    createOrReuseCheckout.mockRejectedValue(new PricingError("variant_required", "p-1"));
    const res2 = await POST(req({}));
    expect(res2.status).toBe(400);
    expect((await res2.json()).code).toBe("variant_required");
  });

  it("retries once on a concurrent-checkout unique violation", async () => {
    createOrReuseCheckout
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }))
      .mockResolvedValueOnce({ ...RESULT, reused: true });
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect((await res.json()).reused).toBe(true);
    expect(createOrReuseCheckout).toHaveBeenCalledTimes(2);
  });

  it("returns 409 payment_in_progress instead of replacing an order being paid", async () => {
    createOrReuseCheckout.mockRejectedValue(new PaymentInProgressError("order-9"));
    const res = await POST(req({}));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "payment_in_progress", orderId: "order-9" });
  });

  it("refuses fraud-blocked accounts", async () => {
    isUserFraudBlocked.mockResolvedValue(true);
    const res = await POST(req({}));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("account_blocked");
  });

  it("returns 503 when Stripe credentials are invalid", async () => {
    createOrReuseCheckout.mockRejectedValue(Object.assign(new Error("x"), { type: "StripeAuthenticationError" }));
    const res = await POST(req({}));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unavailable");
  });

  it("fails closed before touching the cart when payments are not configured", async () => {
    shopPaymentsConfigured.mockReturnValue(false);
    const res = await POST(req({}));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unavailable");
    expect(getOrCreateCart).not.toHaveBeenCalled();
    expect(createOrReuseCheckout).not.toHaveBeenCalled();
  });
});
