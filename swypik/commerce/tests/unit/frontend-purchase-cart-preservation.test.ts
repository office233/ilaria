import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ effect: null as (() => void) | null }));
vi.mock("react", () => ({ useEffect: (effect: () => void) => { harness.effect = effect; } }));
vi.mock("@/lib/feed/track", () => ({ trackEventImmediate: vi.fn().mockResolvedValue(undefined) }));
import PurchaseTracker from "@/components/PurchaseTracker";
import { trackEventImmediate } from "@/lib/feed/track";

describe("purchase confirmation preserves new shopping cart", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it("tracks a paid order without deleting the shopper's current server cart", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal("window", { localStorage: { removeItem: vi.fn() } });
    PurchaseTracker({ orderId: "old-paid-order" });
    harness.effect?.();
    expect(trackEventImmediate).toHaveBeenCalledWith("purchase", expect.objectContaining({ metadata: expect.objectContaining({ order_id: "old-paid-order" }) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
