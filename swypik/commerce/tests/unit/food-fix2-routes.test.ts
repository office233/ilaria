/**
 * Audit food-go (fix2): coordonate obligatorii, card doar cu Stripe configurat,
 * hold card → încasare la acceptare, watchdog pentru comenzi neacceptate,
 * quote fără (0,0), comenzi card neautorizate ascunse restaurantului.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  stripeOn: true,
  seller: "s-1" as string | null,
  pi: { id: "pi_1", status: "requires_capture", amount_capturable: 3400, metadata: { local_order_id: "" } } as Record<string, unknown>,
  capture: vi.fn(),
  transition: vi.fn(),
  effects: vi.fn(async () => ({ refund: { status: "not_required", ledgerReversed: 0 } })),
  notify: vi.fn(async () => true),
  calls: [] as { sql: string; params: unknown[] }[],
  order: { id: "", status: "placed", payment_method: "card_online", payment_status: "pending", payment_intent_id: "pi_1", total_cents: 3400 } as Record<string, unknown>,
  stale: [] as { id: string }[],
  menuOptions: [] as unknown[],
}));

vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => null }));
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => h.seller }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }), getClientIP: () => "203.0.113.9" }));
vi.mock("@/lib/payments/mobility-stripe", () => ({ stripeConfigured: () => h.stripeOn }));
vi.mock("@/lib/payments/eats-stripe", () => ({ createLocalOrderPaymentIntent: vi.fn(async () => { throw new Error("stripe down"); }) }));
vi.mock("@/lib/dispatch/auto", () => ({ maybeAutoDispatch: vi.fn() }));
vi.mock("@/lib/pricing/delivery", () => ({
  resolveDeliveryFee: vi.fn(async () => ({ fee_cents: 900, source: "fixed", zone_id: null, distance_km: null, surge_multiplier: null, breakdown: null })),
}));
vi.mock("@/lib/food/transition", () => ({ transitionOrder: h.transition }));
vi.mock("@/lib/food/transition-effects", () => ({ runTransitionEffects: h.effects }));
vi.mock("@/lib/food/merchant-notify", () => ({ notifyMerchantNewOrder: h.notify }));
vi.mock("@/lib/stripe/checkout", () => ({
  getStripe: () => ({
    paymentIntents: {
      retrieve: async () => h.pi,
      capture: h.capture,
    },
  }),
}));

const ALWAYS_OPEN = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "23:59"]]]));
const MID = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const OID = "33333333-3333-4333-8333-333333333333";

vi.mock("@/lib/db", () => {
  const run = async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    if (sql.includes("FROM local_merchants WHERE id = $1") && sql.includes("listing_mode")) {
      return { rows: [{ id: MID, status: "active", listing_mode: "orderable", opening_hours: ALWAYS_OPEN, is_open_override: null, min_order_cents: 0, avg_prep_minutes: 20, location_country: "RO" }], rowCount: 1 };
    }
    if (sql.includes("FROM menu_items WHERE merchant_id")) {
      return { rows: [{ id: ITEM, name: "Pizza", price_cents: 2500, currency: "RON", options: h.menuOptions, is_available: true }], rowCount: 1 };
    }
    if (sql.includes("FROM local_orders WHERE id = $1") && sql.includes("payment_intent_id")) return { rows: [h.order], rowCount: 1 };
    if (sql.includes("JOIN local_merchants m ON m.id = lo.merchant_id") && sql.includes("m.seller_id = $2")) {
      return { rows: h.seller === "s-1" ? [{ id: OID }] : [], rowCount: 1 };
    }
    if (sql.includes("WHERE status = 'placed' AND placed_at <")) return { rows: h.stale, rowCount: h.stale.length };
    if (sql.includes("FROM local_merchants WHERE id = $1 AND status = 'active'")) {
      return { rows: [{ delivery_fee_cents: 900, delivery_radius_km: 5, location_lat: 46.77, location_lng: 23.6 }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO local_orders")) return { rows: [{ id: OID, order_number: "LO-1", status: "placed" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { dbQuery: vi.fn(run), withTransaction: vi.fn(async (fn: (q: typeof run) => unknown) => fn(run)) };
});

import { POST as placeOrder } from "@/app/api/local-orders/route";
import { PATCH as orderStatus } from "@/app/api/local-orders/[id]/status/route";
import { GET as deliveryQuote } from "@/app/api/merchants/[id]/delivery-quote/route";
import { captureLocalOrderPayment, syncLocalOrderAuthorization } from "@/lib/food/card-payment";
import { runFoodWatchdog } from "@/lib/food/watchdog";

function orderReq(extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/local-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      merchant_id: MID,
      items: [{ menu_item_id: ITEM, qty: 1 }],
      customer_name: "Ana Pop",
      customer_phone: "+40711111111",
      delivery_address: "Str. Exemplu 1, Cluj",
      delivery_lat: 46.77,
      delivery_lng: 23.6,
      ...extra,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.stripeOn = true;
  h.seller = "s-1";
  h.menuOptions = [];
  h.stale = [];
  h.order = { id: OID, status: "placed", payment_method: "card_online", payment_status: "pending", payment_intent_id: "pi_1", total_cents: 3400 };
  h.pi = { id: "pi_1", status: "requires_capture", amount_capturable: 3400, metadata: { local_order_id: OID } };
  h.capture.mockResolvedValue({ id: "pi_1", status: "succeeded" });
  h.transition.mockResolvedValue({ ok: true, order: { id: OID }, previousStatus: "placed", customerUserId: null, merchantName: "M", courierId: null });
});

describe("POST /api/local-orders", () => {
  it("requires real delivery coordinates (audit #8, #17)", async () => {
    for (const extra of [{ delivery_lat: undefined, delivery_lng: undefined }, { delivery_lat: 0, delivery_lng: 0 }, { delivery_lat: "46.7" }]) {
      const res = await placeOrder(orderReq(extra));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("delivery_location_required");
    }
  });

  it("refuses card when Stripe is not configured and the removed card_courier (audit #16)", async () => {
    h.stripeOn = false;
    const res = await placeOrder(orderReq({ payment_method: "card_online" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("payment_method_unavailable");
    expect((await placeOrder(orderReq({ payment_method: "card_courier" }))).status).toBe(400);
  });

  it("enforces required options server-side (audit #15)", async () => {
    h.menuOptions = [{ name: "Mărime", required: true, choices: [{ name: "Mare", price_cents: 500 }] }];
    const res = await placeOrder(orderReq());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("option_required");
  });

  it("cash order notifies the merchant right away", async () => {
    const res = await placeOrder(orderReq());
    expect(res.status).toBe(200);
    expect(h.notify).toHaveBeenCalledWith(OID);
  });

  it("card order whose PaymentIntent cannot be created is cancelled, not left unpaid (audit #16)", async () => {
    const res = await placeOrder(orderReq({ payment_method: "card_online" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("card_unavailable");
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ orderId: OID, to: "cancelled", actor: "system" }));
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("card hold → capture on merchant accept (audit #7)", () => {
  it("syncs an authorized hold", async () => {
    expect(await syncLocalOrderAuthorization(OID)).toBe("authorized");
    expect(h.calls.some((c) => c.sql.includes("payment_authorized_at = COALESCE"))).toBe(true);
  });

  it("captures on accept and marks paid", async () => {
    expect(await captureLocalOrderPayment(OID)).toEqual({ ok: true });
    expect(h.capture).toHaveBeenCalledWith("pi_1", {}, { idempotencyKey: `local_order:${OID}:capture` });
    expect(h.calls.some((c) => c.sql.includes("SET payment_status = 'paid'"))).toBe(true);
  });

  it("refuses to capture without a hold", async () => {
    h.pi = { ...h.pi, status: "requires_payment_method" };
    expect(await captureLocalOrderPayment(OID)).toEqual({ ok: false, code: "unpaid_card" });
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("status route: accept captures first; a failed capture blocks the transition", async () => {
    const patch = () =>
      orderStatus(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ status: "accepted" }) }), {
        params: Promise.resolve({ id: OID }),
      });
    expect((await patch()).status).toBe(200);
    expect(h.capture).toHaveBeenCalled();
    expect(h.transition).toHaveBeenCalled();

    vi.clearAllMocks();
    h.pi = { ...h.pi, status: "canceled" };
    const res = await patch();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("unpaid_card");
    expect(h.transition).not.toHaveBeenCalled();
  });
});

describe("food watchdog", () => {
  it("cancels stale placed orders as system and runs refund effects", async () => {
    h.stale = [{ id: OID }];
    const r = await runFoodWatchdog();
    expect(r.auto_cancelled).toBe(1);
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ orderId: OID, to: "cancelled", actor: "system", reason: "merchant_timeout" }));
    expect(h.effects).toHaveBeenCalledWith(expect.objectContaining({ orderId: OID, status: "cancelled" }));
  });
});

describe("GET /api/merchants/[id]/delivery-quote (audit #17)", () => {
  it("missing coordinates are not (0,0) → never out_of_range", async () => {
    const res = await deliveryQuote(new Request("http://localhost/x"), { params: Promise.resolve({ id: MID }) });
    const body = await res.json();
    expect(body.quote.out_of_range).toBe(false);
    expect(body.quote.has_location).toBe(false);
  });
});
