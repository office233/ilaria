import { describe, expect, it } from "vitest";
import {
  boundedImages,
  CatalogProviderError,
  moneyMagnitudeToCents,
  moneyToCents,
  normalizeCurrency,
  plainText,
} from "@/lib/seller/imports/common";
import { normalizeShopifyStore } from "@/lib/seller/imports/shopify";

describe("seller catalog import normalization", () => {
  it("parses money deterministically in minor units", () => {
    expect(moneyToCents("12.34")).toBe(1234);
    expect(moneyToCents(10.005)).toBe(1001);
    expect(moneyToCents("-1")).toBeNull();
    expect(moneyToCents("nope")).toBeNull();
  });

  it("normalizes refund magnitudes regardless of provider sign convention", () => {
    expect(moneyMagnitudeToCents("12.34")).toBe(1234);
    expect(moneyMagnitudeToCents("-12.34")).toBe(1234);
  });

  it("requires ISO-like 3-letter currencies", () => {
    expect(normalizeCurrency(" eur ")).toBe("EUR");
    expect(() => normalizeCurrency("EURO")).toThrow(CatalogProviderError);
  });

  it("removes markup and script/style payloads from imported descriptions", () => {
    expect(
      plainText('<p>Hello <strong>world</strong></p><script>alert("x")</script>'),
    ).toBe("Hello world");
  });

  it("keeps only unique HTTPS product images", () => {
    expect(
      boundedImages([
        "https://cdn.example.com/a.jpg",
        "http://cdn.example.com/b.jpg",
        "https://127.0.0.1/private.jpg",
        "https://cdn.example.com/a.jpg",
        "invalid",
      ]),
    ).toEqual(["https://cdn.example.com/a.jpg"]);
  });
});

describe("normalizeShopifyStore", () => {
  it("normalizes canonical myshopify domains", () => {
    expect(normalizeShopifyStore("HTTPS://Example-Store.myshopify.com/")).toBe(
      "example-store.myshopify.com",
    );
  });

  it("rejects arbitrary custom hosts", () => {
    expect(() => normalizeShopifyStore("https://shop.example.com")).toThrowError(
      expect.objectContaining({ code: "invalid_shopify_store" }),
    );
  });
});
