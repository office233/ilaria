import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ construct: vi.fn(), query: vi.fn(), checkout: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => ({ webhooks: { constructEvent: mocks.construct } }) }));
vi.mock("@/lib/db", () => ({ dbQuery: mocks.query }));
vi.mock("@/lib/security/audit-log", () => ({ logCheckoutEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ getClientIP: () => "127.0.0.1" }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/api/webhooks/stripe/_handlers/checkout", () => ({ handleCheckoutCompletedEvent: mocks.checkout }));
vi.mock("@/app/api/webhooks/stripe/_handlers/payments", () => ({ handlePaymentIntentSucceededEvent: vi.fn(), handlePaymentIntentFailed: vi.fn() }));
vi.mock("@/app/api/webhooks/stripe/_handlers/refunds", () => ({ handleChargeRefunded: vi.fn(), handleIntentDead: vi.fn() }));
vi.mock("@/app/api/webhooks/stripe/_handlers/connect", () => ({ handleAccountUpdated: vi.fn() }));
vi.mock("@/app/api/webhooks/stripe/_handlers/disputes", () => ({ handleDisputeEvent: vi.fn() }));
vi.mock("@/app/api/webhooks/stripe/_handlers/creator-unlocks", () => ({ CREATOR_UNLOCK_KINDS: new Set(), handleCreatorUnlockPaymentSucceeded: vi.fn() }));
vi.mock("@/app/api/webhooks/stripe/_handlers/stays", () => ({ handlePaymentIntentCapturable: vi.fn() }));
import { POST } from "@/app/api/webhooks/stripe/route";
const event = { id: "evt_fixture", type: "checkout.session.async_payment_succeeded", data: { object: {} } };
function req(body = "{}", headers = {}) {
  return new Request("https://swypik.com/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": "fixture", ...headers } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fixture");
  mocks.construct.mockReturnValue(event);
  mocks.query.mockResolvedValue({ rows: [{ event_id: event.id }] });
  mocks.audit.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("Stripe webhook ingress", () => {
  it("routes delayed-payment success through checkout fulfillment", async () => {
    expect((await POST(req())).status).toBe(200);
    expect(mocks.checkout).toHaveBeenCalledExactlyOnceWith(event);
  });
  it("rejects unsigned requests without reading their body", async () => {
    const request = req("{}", { "stripe-signature": "" });
    const reader = vi.spyOn(request.body!, "getReader");
    expect((await POST(request)).status).toBe(400);
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects oversized declared bodies before consuming the stream", async () => {
    const request = req("{}", { "content-length": "1048577" });
    const reader = vi.spyOn(request.body!, "getReader");
    expect((await POST(request)).status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it.each([{}, { "content-length": "1" }])("enforces actual byte size even for missing or forged content length", async (headers) => {
    expect((await POST(req("x".repeat(1048577), headers))).status).toBe(413);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("verifies the exact raw bytes", async () => {
    const payload = '{ "unicode": "ț", "spacing": true }';
    expect((await POST(req(payload))).status).toBe(200);
    expect(mocks.construct.mock.calls[0][0]).toEqual(Buffer.from(payload));
  });
  it("does not process a duplicate event", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await POST(req());
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("releases a failed handler claim and asks Stripe to retry", async () => {
    mocks.checkout.mockRejectedValue(new Error("transient database failure"));
    expect((await POST(req())).status).toBe(500);
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining("DELETE FROM processed_stripe_events"), [event.id]);
  });
});
