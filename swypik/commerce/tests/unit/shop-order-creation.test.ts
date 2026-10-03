import { describe, it, expect, vi, beforeEach } from "vitest";
import { priceCart } from "@/lib/shop/pricing";

// Ordinea creării comenzii (lib/shop/checkout.ts) cu DB + Stripe simulate:
// buyer_user_id scris, prețul variantei, rezervare, reutilizare idempotentă,
// înlocuirea comenzii când coșul se schimbă.

const P1 = "11111111-1111-1111-1111-111111111111";
const V1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER = "99999999-9999-9999-9999-999999999999";
const CART = "cccccccc-0000-0000-0000-000000000001";

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let pendingOrder: Record<string, unknown> | null = null;
let cartQty = 2;

function respond(sql: string, params: unknown[]) {
  calls.push({ sql, params });
  if (sql.includes("FROM cart_items ci")) {
    return { rows: [{ product_id: P1, variant_id: V1, quantity: cartQty, video_id: null }], rowCount: 1 };
  }
  if (sql.includes("FROM commerce_orders") && sql.includes("metadata->>'cart_id' = $1")) {
    return { rows: pendingOrder ? [pendingOrder] : [], rowCount: pendingOrder ? 1 : 0 };
  }
  if (sql.includes("FROM marketplace_products p") && sql.includes("FOR UPDATE")) {
    return {
      rows: [{ id: P1, title: "Tricou", price_cents: 5000, currency: "RON", listing_type: "product", purchasable: true, stock: null, seller_id: "s-1" }],
      rowCount: 1,
    };
  }
  if (sql.includes("FROM marketplace_product_variants")) {
    return { rows: [{ id: V1, product_id: P1, title: "M", price_cents: 6500, inventory_quantity: 10, status: "active" }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO commerce_orders")) return { rows: [{ id: "order-new" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

vi.mock("@/lib/db", () => {
  const q = vi.fn(async (sql: string, params: unknown[] = []) => respond(sql, params));
  return { dbQuery: q, withTransaction: async <T,>(fn: (tx: typeof q) => Promise<T>) => fn(q) };
});

vi.mock("@/lib/checkout/attribution", () => ({
  resolveCheckoutAttribution: vi.fn(async () => ({ creatorId: "creator-1", videoId: "video-1" })),
}));

const stripe = {
  paymentIntents: {
    create: vi.fn(async (p: { amount: number }) => ({ id: "pi_new", client_secret: "secret_new", amount: p.amount })),
    retrieve: vi.fn(async () => ({ id: "pi_old", client_secret: "secret_old", status: "requires_payment_method" })),
    cancel: vi.fn(async () => ({})),
  },
};
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => stripe }));

import { createOrReuseCheckout } from "@/lib/shop/checkout";

const ctx = { cartId: CART, buyer: { userId: USER, email: "ana@example.com" }, ipCountry: "RO", userAgent: "ua" };

function fingerprintFor(qty: number) {
  return priceCart(
    [{ productId: P1, variantId: V1, quantity: qty }],
    new Map([[P1, { id: P1, title: "Tricou", priceCents: 5000, currency: "RON", stock: null, listingType: "product", purchasable: true }]]),
    [{ id: V1, productId: P1, title: "M", priceCents: 6500, stock: 10, status: "active" }],
    new Map(),
    { shippingFlatCents: 0, freeShippingThresholdCents: null, maxLineQty: 10, reservationMinutes: 30, currency: "RON" },
  ).fingerprint;
}

beforeEach(() => {
  calls.length = 0;
  pendingOrder = null;
  cartQty = 2;
  vi.clearAllMocks();
});

describe("createOrReuseCheckout", () => {
  it("creates an order with buyer_user_id, the variant price and a stock reservation", async () => {
    const res = await createOrReuseCheckout(ctx);
    expect(res.reused).toBe(false);
    expect(res.totalCents).toBe(13000);

    const orderInsert = calls.find((c) => c.sql.includes("INSERT INTO commerce_orders"))!;
    expect(orderInsert.params[0]).toBe(USER);
    expect(orderInsert.sql).toContain("reserved_until");
    const meta = JSON.parse(String(orderInsert.params[6]));
    expect(meta.customer_email).toBe("ana@example.com");
    expect(meta.cart_id).toBe(CART);

    const itemInsert = calls.find((c) => c.sql.includes("INSERT INTO commerce_order_items"))!;
    expect(itemInsert.params[2]).toBe(V1); // variant_id
    expect(itemInsert.params[10]).toBe(6500); // unit price = variant price
    expect(itemInsert.params[3]).toBe("creator-1");

    const piArgs = stripe.paymentIntents.create.mock.calls[0][0] as Record<string, unknown>;
    expect(piArgs.amount).toBe(13000);
    expect(piArgs.receipt_email).toBe("ana@example.com");
    expect((piArgs.metadata as Record<string, string>).orderId).toBe("order-new");
  });

  it("reuses the pending order and PaymentIntent when the cart did not change", async () => {
    pendingOrder = { id: "order-old", total_cents: 13000, fingerprint: fingerprintFor(2), pi: "pi_old", token: "tok" };
    const res = await createOrReuseCheckout(ctx);
    expect(res.reused).toBe(true);
    expect(res.orderId).toBe("order-old");
    expect(res.clientSecret).toBe("secret_old");
    expect(calls.some((c) => c.sql.includes("INSERT INTO commerce_orders"))).toBe(false);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("SET reserved_until = now()"))).toBe(true);
  });

  it("supersedes the old pending order when the cart changed", async () => {
    pendingOrder = { id: "order-old", total_cents: 13000, fingerprint: fingerprintFor(2), pi: "pi_old", token: "tok" };
    cartQty = 3;
    const res = await createOrReuseCheckout(ctx);
    expect(res.reused).toBe(false);
    expect(res.orderId).toBe("order-new");
    expect(res.totalCents).toBe(19500);
    const cancel = calls.find((c) => c.sql.includes("SET status = 'cancelled'"));
    expect(cancel?.params[0]).toBe("order-old");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_old");
    // The reservation check must not count the order being replaced.
    const reservedQuery = calls.find((c) => c.sql.includes("reserved_until > now()"));
    expect(reservedQuery?.params[1]).toBe("order-old");
  });

  it("refuses to supersede an order whose payment is already processing", async () => {
    pendingOrder = { id: "order-old", total_cents: 13000, fingerprint: fingerprintFor(2), pi: "pi_old", token: "tok" };
    cartQty = 3;
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_old", client_secret: "s", status: "processing" });
    await expect(createOrReuseCheckout(ctx)).rejects.toMatchObject({ code: "payment_in_progress", orderId: "order-old" });
    expect(calls.some((c) => c.sql.includes("SET status = 'cancelled'"))).toBe(false);
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("marks the order failed and rethrows when Stripe refuses", async () => {
    stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error("auth"), { type: "StripeAuthenticationError" }));
    await expect(createOrReuseCheckout(ctx)).rejects.toThrow("auth");
    expect(calls.some((c) => c.sql.includes("SET status = 'failed'"))).toBe(true);
  });
});
