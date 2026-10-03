import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const mocks = vi.hoisted(() => ({ stripe: vi.fn(), query: vi.fn(), transaction: vi.fn(), fulfill: vi.fn() }));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: mocks.stripe }));
vi.mock("@/lib/db", () => ({ dbQuery: mocks.query, withTransaction: mocks.transaction }));
vi.mock("@/lib/fulfillment/order-router", () => ({ routeOrder: vi.fn() }));
vi.mock("@/lib/referral/validation", () => ({ onOrderPaid: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/app/api/webhooks/stripe/_handlers/shared", () => ({ maybeSendOrderConfirmation: vi.fn() }));
vi.mock("@/lib/fly/booking", () => ({ fulfillFlightBooking: mocks.fulfill }));
import { handleCheckoutCompletedEvent } from "@/app/api/webhooks/stripe/_handlers/checkout";
function event(paymentStatus: string, type = "checkout.session.completed", metadata = {}) {
  return { type, data: { object: { id: "cs_fixture", payment_status: paymentStatus, metadata } } } as unknown as Stripe.Event;
}
beforeEach(() => vi.clearAllMocks());
describe("Checkout settlement", () => {
  it.each([{}, { fly_booking_id: "flight_fixture" }])("does not fulfill unpaid Checkout, including alternate verticals", async (metadata) => {
    await handleCheckoutCompletedEvent(event("unpaid", undefined, metadata));
    expect(mocks.stripe).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("allows fulfillment after delayed payment succeeds", async () => {
    await handleCheckoutCompletedEvent(event("paid", "checkout.session.async_payment_succeeded", { fly_booking_id: "flight_fixture" }));
    expect(mocks.fulfill).toHaveBeenCalledExactlyOnceWith("flight_fixture");
  });
  it("keeps zero-payment sessions eligible", async () => {
    await handleCheckoutCompletedEvent(event("no_payment_required", undefined, { fly_booking_id: "flight_fixture" }));
    expect(mocks.fulfill).toHaveBeenCalledExactlyOnceWith("flight_fixture");
  });
});
