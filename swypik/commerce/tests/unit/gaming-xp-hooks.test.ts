import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Cârligele de XP: „primul clip publicat" (momentul unic în care clipul devine
 * vizibil — notifyFollowersOnce) și „prima comandă plătită" (tranziția
 * pending→paid din webhook-ul Stripe). awardMilestoneXp e idempotent în sine
 * (testat în gaming-xp-award.test.ts); aici verificăm că hook-urile îl cheamă
 * doar pe tranziția reală, cu utilizatorul corect.
 */

const award = vi.hoisted(() => vi.fn(async () => 100));
const db = vi.hoisted(() => ({
  notifyRows: [] as Array<{ creator_id: string }>,
  transitionRows: [] as Array<{ id: string; buyer_user_id: string | null }>,
  orderStatus: "pending",
}));

vi.mock("@/lib/gaming/activity-xp", () => ({ awardMilestoneXp: award }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("followers_notified_at") && sql.includes("RETURNING creator_id")) return { rows: db.notifyRows, rowCount: db.notifyRows.length };
    if (sql.includes("SELECT id, status, currency, total_cents FROM commerce_orders")) {
      return { rows: [{ id: "o1", status: db.orderStatus, currency: "RON", total_cents: 1000 }], rowCount: 1 };
    }
    if (sql.includes("RETURNING id, buyer_user_id")) return { rows: db.transitionRows, rowCount: db.transitionRows.length };
    return { rows: [], rowCount: 0 };
  }),
  withTransaction: vi.fn(),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notifyFollowersNewPost: vi.fn(async () => undefined) }));
vi.mock("@/lib/fulfillment/order-router", () => ({ routeOrder: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/audit-log", () => ({ logCheckoutEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/risk/order-fraud-score", () => ({ scoreOrderRisk: vi.fn(() => ({ score: 0, reasons: [] })) }));
vi.mock("@/lib/ops/alerts", () => ({ notifyOps: vi.fn(async () => undefined) }));
vi.mock("@/lib/payments/eats-stripe", () => ({ markLocalOrderPaid: vi.fn(), markLocalOrderPaymentFailed: vi.fn() }));
vi.mock("@/lib/dispatch/auto", () => ({ maybeAutoDispatch: vi.fn() }));
vi.mock("@/lib/payments/mobility", () => ({ settleRide: vi.fn() }));
vi.mock("@/lib/algo/attribution", () => ({ attributeOrder: vi.fn(async () => undefined) }));
vi.mock("@/lib/referral/validation", () => ({ onOrderPaid: vi.fn(async () => undefined), onRidePaid: vi.fn(), onLocalOrderPaid: vi.fn() }));
vi.mock("@/lib/stays/stripe-payment", () => ({ markStayBookingPaidByCard: vi.fn(), markStayBookingCardFailed: vi.fn() }));
vi.mock("@/lib/shop/order-paid", () => ({ finalizePaidShopOrder: vi.fn(async () => undefined) }));
vi.mock("@/lib/missions/funding", () => ({ markMissionFunded: vi.fn() }));
vi.mock("@/app/api/webhooks/stripe/_handlers/shared", () => ({ maybeSendOrderConfirmation: vi.fn(async () => undefined) }));

import { notifyFollowersOnce } from "@/lib/video/publish-notify";
import { handlePaymentIntentSucceededEvent } from "@/app/api/webhooks/stripe/_handlers/payments";

const paidEvent = () =>
  ({
    data: { object: { id: "pi_1", amount: 1000, currency: "ron", metadata: { orderId: "o1" }, shipping: null } },
  }) as unknown as Stripe.Event;

beforeEach(() => {
  award.mockClear();
  db.notifyRows = [];
  db.transitionRows = [];
  db.orderStatus = "pending";
});

describe("first_upload — când clipul devine vizibil prima dată", () => {
  it("acordă XP creatorului la prima tranziție", async () => {
    db.notifyRows = [{ creator_id: "creator-1" }];
    await expect(notifyFollowersOnce("v1")).resolves.toBe(true);
    expect(award).toHaveBeenCalledWith("creator-1", "first_upload");
  });

  it("nimic când clipul era deja notificat / nu e încă vizibil", async () => {
    await expect(notifyFollowersOnce("v1")).resolves.toBe(false);
    expect(award).not.toHaveBeenCalled();
  });
});

describe("first_purchase — tranziția pending→paid din webhook", () => {
  it("acordă XP cumpărătorului cu cont", async () => {
    db.transitionRows = [{ id: "o1", buyer_user_id: "buyer-1" }];
    await handlePaymentIntentSucceededEvent(paidEvent());
    expect(award).toHaveBeenCalledWith("buyer-1", "first_purchase");
  });

  it("webhook reluat (comanda nu mai e pending) → fără XP", async () => {
    db.orderStatus = "paid";
    await handlePaymentIntentSucceededEvent(paidEvent());
    expect(award).not.toHaveBeenCalled();
  });

  it("cursă concurentă (UPDATE nu mai găsește pending) → fără XP", async () => {
    db.transitionRows = [];
    await handlePaymentIntentSucceededEvent(paidEvent());
    expect(award).not.toHaveBeenCalled();
  });
});
