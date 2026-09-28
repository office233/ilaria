import { describe, it, expect } from "vitest";
import {
  draftFromProduct,
  draftToCreatePayload,
  draftToUpdatePayload,
  emptyDraft,
  netAfterCommission,
  validateDraft,
} from "@/components/seller/products/form-model";
import { buildOnboarding } from "@/lib/seller/onboarding";
import { SELLER_NAV, visibleSellerNav } from "@/lib/seller/nav";

describe("form-model produs", () => {
  const product = {
    id: "p1",
    title: "Tricou",
    description: "Bumbac",
    brand: null,
    category: "Haine",
    taxonomy_node_slug: "haine",
    price_cents: 4999,
    compare_at_price_cents: 5999,
    shipping_cost_cents: null,
    currency: "RON",
    status: "active",
    image_url: "https://cdn/x.jpg",
    metadata: { available_stock: 7, sku: "TR-1", image_urls: ["https://cdn/x.jpg", "https://cdn/y.jpg"], courier: "sameday" },
    variants: [{ id: "v1", title: "M", sku: null, price_cents: null, inventory_quantity: 3 }],
  };

  it("produs → ciornă → PATCH păstrează valorile (dus-întors)", () => {
    const d = draftFromProduct(product);
    expect(d).toMatchObject({ price: "49.99", compareAt: "59.99", stock: "7", sku: "TR-1", courier: "sameday" });
    expect(draftToUpdatePayload(d)).toMatchObject({
      price: 49.99,
      compare_at_price: 59.99,
      stock: 7,
      image_urls: ["https://cdn/x.jpg", "https://cdn/y.jpg"],
      shipping_cost: null,
      variants: [{ id: "v1", title: "M", sku: null, price_cents: null, inventory_quantity: 3 }],
    });
  });

  it("POST omite câmpurile goale (schema de creare nu acceptă null) și statusul", () => {
    const d = { ...emptyDraft(), title: "Cană", price: "20,5", stock: "3" };
    expect(draftToCreatePayload(d, "RON")).toEqual({ currency: "RON", title: "Cană", price: 20.5, stock: 3 });
  });

  it("validare: titlu, preț, stoc, preț comparativ, zile livrare, variante", () => {
    const ok = { ...emptyDraft(), title: "Cană", price: "20", stock: "0" };
    expect(validateDraft(ok)).toBeNull();
    expect(validateDraft({ ...ok, title: "ab" })).toBe("title");
    expect(validateDraft({ ...ok, price: "0" })).toBe("price");
    expect(validateDraft({ ...ok, stock: "-1" })).toBe("stock");
    expect(validateDraft({ ...ok, compareAt: "10" })).toBe("compareAt");
    expect(validateDraft({ ...ok, shippingDaysMin: "5", shippingDaysMax: "2" })).toBe("shippingDays");
    expect(validateDraft({ ...ok, variants: [{ title: "", sku: "", price: "", stock: "" }] })).toBe("variant");
  });

  it("netul după comision vine din bps (nu din 7% scris în UI)", () => {
    expect(netAfterCommission(10000, 1000)).toBe(9000);
    expect(netAfterCommission(4999, 1000)).toBe(4499);
  });
});

describe("onboarding seller", () => {
  const base = {
    status: "approved", isVerified: false, hasName: true, hasCui: true, hasPhone: false,
    hasIban: false, connectReady: false, productCount: 0,
  };
  it("pașii obligatorii lipsă țin checklist-ul deschis", () => {
    const o = buildOnboarding(base);
    expect(o.complete).toBe(false);
    expect(o.requiredTotal).toBe(5);
    expect(o.requiredDone).toBe(1);
  });
  it("totul gata → complet", () => {
    const o = buildOnboarding({ ...base, isVerified: true, hasPhone: true, hasIban: true, productCount: 2 });
    expect(o.complete).toBe(true);
  });
  it("Stripe Connect activ ține loc de IBAN", () => {
    const o = buildOnboarding({ ...base, connectReady: true });
    expect(o.steps.find((s) => s.id === "payout")?.done).toBe(true);
  });
});

describe("nav seller (o singură listă)", () => {
  it("păstrează Restaurant și Misiuni; retururile apar doar cu flag", () => {
    const hrefs = SELLER_NAV.map((i) => i.href);
    expect(hrefs).toEqual(expect.arrayContaining(["/seller/merchant", "/seller/missions", "/seller/payouts"]));
    expect(hrefs.some((h) => h.startsWith("/seller/erp"))).toBe(false);
    expect(visibleSellerNav(() => false).some((i) => i.id === "returns")).toBe(false);
    expect(visibleSellerNav(() => true).some((i) => i.id === "returns")).toBe(true);
  });
  it("id-uri și rute unice", () => {
    expect(new Set(SELLER_NAV.map((i) => i.id)).size).toBe(SELLER_NAV.length);
    expect(new Set(SELLER_NAV.map((i) => i.href)).size).toBe(SELLER_NAV.length);
  });
});
