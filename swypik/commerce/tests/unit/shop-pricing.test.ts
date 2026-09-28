import { describe, it, expect } from "vitest";
import {
  PricingError,
  cartFingerprint,
  priceCart,
  priceLine,
  shippingFor,
  stockKey,
  type PricingProduct,
  type PricingVariant,
} from "@/lib/shop/pricing";
import type { ShopConfig } from "@/lib/shop/config";

const CONFIG: ShopConfig = {
  shippingFlatCents: 0,
  freeShippingThresholdCents: null,
  maxLineQty: 10,
  reservationMinutes: 30,
  currency: "RON",
};

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const V1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const V2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FOREIGN_V = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function product(over: Partial<PricingProduct> = {}): PricingProduct {
  return {
    id: P1,
    title: "Tricou",
    priceCents: 5000,
    currency: "RON",
    stock: null,
    listingType: "product",
    purchasable: true,
    sellerId: "seller-1",
    ...over,
  };
}

function variant(over: Partial<PricingVariant> = {}): PricingVariant {
  return { id: V1, productId: P1, title: "M / Roșu", priceCents: 6500, stock: 5, status: "active", ...over };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PricingError);
    expect((err as PricingError).code).toBe(code);
    return err as PricingError;
  }
  throw new Error(`expected PricingError ${code}`);
}

describe("priceLine", () => {
  it("charges the base price when the product has no variants", () => {
    const line = priceLine({ productId: P1, variantId: null, quantity: 2 }, product(), [], new Map(), CONFIG);
    expect(line.unitCents).toBe(5000);
    expect(line.lineCents).toBe(10000);
    expect(line.variantId).toBeNull();
    expect(line.sellerId).toBe("seller-1");
  });

  it("charges the SELECTED variant price, not the base price", () => {
    const line = priceLine({ productId: P1, variantId: V1, quantity: 1 }, product(), [variant()], new Map(), CONFIG);
    expect(line.unitCents).toBe(6500);
    expect(line.variantId).toBe(V1);
    expect(line.title).toBe("Tricou — M / Roșu");
  });

  it("falls back to the product price when the variant has no own price", () => {
    const line = priceLine(
      { productId: P1, variantId: V1, quantity: 1 },
      product(),
      [variant({ priceCents: null })],
      new Map(),
      CONFIG,
    );
    expect(line.unitCents).toBe(5000);
  });

  it("rejects a variant belonging to another product (no cross-product price injection)", () => {
    const foreign = variant({ id: FOREIGN_V, productId: P2, priceCents: 1 });
    expectCode(
      () => priceLine({ productId: P1, variantId: FOREIGN_V, quantity: 1 }, product(), [variant(), foreign], new Map(), CONFIG),
      "variant_unavailable",
    );
  });

  it("requires a variant when the product has sellable variants", () => {
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 1 }, product(), [variant()], new Map(), CONFIG), "variant_required");
  });

  it("rejects archived variants", () => {
    expectCode(
      () => priceLine({ productId: P1, variantId: V1, quantity: 1 }, product(), [variant({ status: "archived" })], new Map(), CONFIG),
      "variant_unavailable",
    );
  });

  it("rejects listings (flights etc.) and unpurchasable products", () => {
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 1 }, product({ listingType: "listing" }), [], new Map(), CONFIG), "not_purchasable");
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 1 }, product({ purchasable: false }), [], new Map(), CONFIG), "not_purchasable");
  });

  it("rejects missing or unpriced products", () => {
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 1 }, undefined, [], new Map(), CONFIG), "product_unavailable");
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 1 }, product({ priceCents: 0 }), [], new Map(), CONFIG), "product_unavailable");
  });

  it("enforces quantity bounds from config", () => {
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 0 }, product(), [], new Map(), CONFIG), "invalid_quantity");
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 11 }, product(), [], new Map(), CONFIG), "invalid_quantity");
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 1.5 }, product(), [], new Map(), CONFIG), "invalid_quantity");
  });

  it("subtracts quantities reserved by other pending orders from the stock", () => {
    const reserved = new Map([[stockKey(P1, V1), 4]]);
    const err = expectCode(
      () => priceLine({ productId: P1, variantId: V1, quantity: 2 }, product(), [variant({ stock: 5 })], reserved, CONFIG),
      "insufficient_stock",
    );
    expect(err.available).toBe(1);
    const ok = priceLine({ productId: P1, variantId: V1, quantity: 1 }, product(), [variant({ stock: 5 })], reserved, CONFIG);
    expect(ok.quantity).toBe(1);
  });

  it("uses product-level stock when there is no variant; null stock = unlimited", () => {
    expectCode(() => priceLine({ productId: P1, variantId: null, quantity: 3 }, product({ stock: 2 }), [], new Map(), CONFIG), "insufficient_stock");
    expect(priceLine({ productId: P1, variantId: null, quantity: 10 }, product({ stock: null }), [], new Map(), CONFIG).quantity).toBe(10);
  });
});

describe("priceCart", () => {
  const products = new Map([
    [P1, product()],
    [P2, product({ id: P2, title: "Cană", priceCents: 2500, stock: 3 })],
  ]);

  it("sums lines and applies shipping from config", () => {
    const priced = priceCart(
      [
        { productId: P1, variantId: V1, quantity: 2 },
        { productId: P2, variantId: null, quantity: 1 },
      ],
      products,
      [variant(), variant({ id: V2, title: "L" })],
      new Map(),
      { ...CONFIG, shippingFlatCents: 1500 },
    );
    expect(priced.subtotalCents).toBe(6500 * 2 + 2500);
    expect(priced.shippingCents).toBe(1500);
    expect(priced.totalCents).toBe(6500 * 2 + 2500 + 1500);
    expect(priced.currency).toBe("RON");
  });

  it("throws cart_empty for an empty cart", () => {
    expectCode(() => priceCart([], products, [], new Map(), CONFIG), "cart_empty");
  });

  it("counts two lines of the same product against the same stock", () => {
    expectCode(
      () =>
        priceCart(
          [
            { productId: P2, variantId: null, quantity: 2 },
            { productId: P2, variantId: null, quantity: 2 },
          ],
          products,
          [],
          new Map(),
          CONFIG,
        ),
      "insufficient_stock",
    );
  });

  it("refuses mixed currencies", () => {
    const mixed = new Map([[P1, product()], [P2, product({ id: P2, currency: "EUR" })]]);
    expectCode(
      () => priceCart([{ productId: P1, variantId: V1, quantity: 1 }, { productId: P2, variantId: null, quantity: 1 }], mixed, [variant()], new Map(), CONFIG),
      "mixed_currency",
    );
  });

  it("does not reuse a checkout fingerprint after its currency changes", () => {
    const inputs = [{ productId: P1, variantId: null, quantity: 1 }];
    const ron = priceCart(inputs, new Map([[P1, product({ currency: "RON" })]]), [], new Map(), CONFIG);
    const eur = priceCart(inputs, new Map([[P1, product({ currency: "EUR" })]]), [], new Map(), CONFIG);
    expect(ron.totalCents).toBe(eur.totalCents);
    expect(ron.fingerprint).not.toBe(eur.fingerprint);
  });

  it("fingerprint is stable across line order and changes with quantity or price", () => {
    const a = priceCart([{ productId: P1, variantId: V1, quantity: 1 }, { productId: P2, variantId: null, quantity: 1 }], products, [variant()], new Map(), CONFIG);
    const b = priceCart([{ productId: P2, variantId: null, quantity: 1 }, { productId: P1, variantId: V1, quantity: 1 }], products, [variant()], new Map(), CONFIG);
    const c = priceCart([{ productId: P1, variantId: V1, quantity: 2 }, { productId: P2, variantId: null, quantity: 1 }], products, [variant()], new Map(), CONFIG);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(cartFingerprint(a.lines, a.totalCents + 1)).not.toBe(a.fingerprint);
  });
});

describe("shippingFor", () => {
  it("is free above the configured threshold", () => {
    const cfg = { shippingFlatCents: 1999, freeShippingThresholdCents: 20000 };
    expect(shippingFor(19999, cfg)).toBe(1999);
    expect(shippingFor(20000, cfg)).toBe(0);
    expect(shippingFor(100, { shippingFlatCents: 1999, freeShippingThresholdCents: null })).toBe(1999);
  });
});
