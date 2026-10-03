import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cleanups: [] as Array<() => void>,
  submit: vi.fn(),
  confirmPayment: vi.fn(),
  available: true,
}));

vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  },
  useState: (initial: unknown) => {
    const index = harness.state.length;
    harness.state.push(initial);
    return [initial, (value: unknown) => { harness.state[index] = value; }];
  },
}));

vi.mock("@stripe/react-stripe-js", () => ({
  useStripe: () => harness.available ? { confirmPayment: harness.confirmPayment } : null,
  useElements: () => harness.available ? { submit: harness.submit } : null,
}));

import { useStripeSubmission } from "@/components/payments/useStripeSubmission";

describe("frontend Stripe submission recovery", () => {
  beforeEach(() => {
    harness.state.length = 0;
    harness.cleanups.length = 0;
    harness.available = true;
    harness.submit.mockReset().mockResolvedValue({});
    harness.confirmPayment.mockReset().mockResolvedValue({});
  });

  it("reports rejected Elements validation and unlocks a subsequent retry", async () => {
    harness.submit.mockRejectedValueOnce(new Error("network disconnected"));
    const form = useStripeSubmission("validation message", "payment message");
    const confirm = vi.fn().mockResolvedValue(undefined);
    await expect(form.submitPayment(confirm)).resolves.toBeUndefined();
    expect(harness.state).toEqual([false, "payment message"]);
    expect(confirm).not.toHaveBeenCalled();

    await form.submitPayment(confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(harness.state).toEqual([false, null]);
  });

  it("does not call Stripe confirmation after invalid payment fields", async () => {
    harness.submit.mockResolvedValueOnce({ error: { message: "Card details incomplete" } });
    const form = useStripeSubmission("validation message", "payment message");
    const confirm = vi.fn();
    await form.submitPayment(confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.state).toEqual([false, "Card details incomplete"]);
  });

  it("catches rejected confirmation and preserves a translated error", async () => {
    harness.confirmPayment.mockRejectedValueOnce(new Error("SDK failure"));
    const form = useStripeSubmission("validation message", "payment message");
    await expect(form.submitPayment(async (stripe) => { await stripe.confirmPayment({} as never); })).resolves.toBeUndefined();
    expect(harness.state).toEqual([false, "payment message"]);
  });

  it("blocks overlapping submissions before the busy state is rendered", async () => {
    let finish: (value: object) => void = () => undefined;
    harness.submit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const form = useStripeSubmission("validation message", "payment message");
    const confirm = vi.fn().mockResolvedValue(undefined);
    const first = form.submitPayment(confirm);
    await form.submitPayment(confirm);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.state[0]).toBe(true);
    finish({});
    await first;
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(harness.state[0]).toBe(false);
  });

  it("does not continue to charge after the payment form was unmounted during validation", async () => {
    let finish: (value: object) => void = () => undefined;
    harness.submit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const form = useStripeSubmission("validation message", "payment message");
    const confirm = vi.fn();
    const request = form.submitPayment(confirm);
    harness.cleanups[0]();
    finish({});
    await request;
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does nothing until Stripe Elements is ready", async () => {
    harness.available = false;
    const form = useStripeSubmission("validation message", "payment message");
    await form.submitPayment(vi.fn());
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.state).toEqual([false, null]);
  });
});
