import { describe, it, expect } from "vitest";
import {
  allowedSellerActions,
  deriveSellerOrderState,
  nextSellerOrderState,
  SELLER_ORDER_ACTIONS,
  SELLER_ORDER_STATES,
} from "@/lib/seller/fulfilment";

const item = (source_status: string, metadata: Record<string, string> = {}) => ({ source_status, metadata });

describe("deriveSellerOrderState", () => {
  it("statusurile finale ale comenzii au prioritate", () => {
    expect(deriveSellerOrderState("refunded", [item("fulfilled")])).toBe("refunded");
    expect(deriveSellerOrderState("return_requested", [item("fulfilled")])).toBe("return_requested");
    expect(deriveSellerOrderState("cancelled", [item("pending_seller_action")])).toBe("cancelled");
  });
  it("comanda neplătită nu e acționabilă", () => {
    expect(deriveSellerOrderState("pending", [item("pending_seller_action")])).toBe("awaiting_payment");
    expect(deriveSellerOrderState("authorized", [item("pending_seller_action")])).toBe("awaiting_payment");
  });
  it("paid: new → accepted (după seller_accepted_at)", () => {
    expect(deriveSellerOrderState("paid", [item("pending_seller_action")])).toBe("new");
    expect(deriveSellerOrderState("paid", [item("pending_seller_action", { seller_accepted_at: "x" })])).toBe("accepted");
  });
  it("toate item-urile expediate → shipped; livrate → delivered", () => {
    expect(deriveSellerOrderState("fulfilled", [item("fulfilled"), item("fulfilled")])).toBe("shipped");
    expect(deriveSellerOrderState("fulfilled", [item("fulfilled", { delivered_at: "x" })])).toBe("delivered");
    expect(deriveSellerOrderState("delivered", [item("fulfilled")])).toBe("delivered");
  });
  it("item-urile anulate sunt ignorate; toate anulate → cancelled", () => {
    expect(deriveSellerOrderState("paid", [item("cancelled"), item("fulfilled")])).toBe("shipped");
    expect(deriveSellerOrderState("paid", [item("cancelled")])).toBe("cancelled");
  });
  it("refund parțial al altui seller nu blochează comanda", () => {
    expect(deriveSellerOrderState("partially_refunded", [item("pending_seller_action")])).toBe("new");
  });
});

describe("nextSellerOrderState — tranziții", () => {
  it("drumul fericit: new → accepted → shipped → delivered", () => {
    expect(nextSellerOrderState("new", "accept")).toEqual({ ok: true, next: "accepted" });
    expect(nextSellerOrderState("accepted", "ship")).toEqual({ ok: true, next: "shipped" });
    expect(nextSellerOrderState("shipped", "deliver")).toEqual({ ok: true, next: "delivered" });
  });
  it("expediere directă din new; anulare doar înainte de expediere", () => {
    expect(nextSellerOrderState("new", "ship")).toEqual({ ok: true, next: "shipped" });
    expect(nextSellerOrderState("new", "cancel")).toEqual({ ok: true, next: "cancelled" });
    expect(nextSellerOrderState("accepted", "cancel")).toEqual({ ok: true, next: "cancelled" });
    expect(nextSellerOrderState("shipped", "cancel")).toEqual({ ok: false, code: "invalid_transition" });
  });
  it("stările terminale nu mai acceptă nimic", () => {
    for (const s of ["delivered", "cancelled", "refunded", "awaiting_payment"] as const) {
      for (const a of SELLER_ORDER_ACTIONS) expect(nextSellerOrderState(s, a).ok).toBe(false);
    }
  });
  it("nu se poate livra ce nu a fost expediat; nu se acceptă de două ori", () => {
    expect(nextSellerOrderState("new", "deliver").ok).toBe(false);
    expect(nextSellerOrderState("accepted", "accept").ok).toBe(false);
  });
  it("orice stare are o intrare în tabel", () => {
    for (const s of SELLER_ORDER_STATES) expect(Array.isArray(allowedSellerActions(s, { returnsEnabled: true }))).toBe(true);
  });
});

describe("allowedSellerActions", () => {
  it("refund_return apare doar cu FEATURE_RETURNS", () => {
    expect(allowedSellerActions("return_requested", { returnsEnabled: false })).toEqual([]);
    expect(allowedSellerActions("return_requested", { returnsEnabled: true })).toEqual(["refund_return"]);
    expect(allowedSellerActions("new", { returnsEnabled: false })).toEqual(["accept", "ship", "cancel"]);
  });
});
