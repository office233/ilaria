import { describe, it, expect } from "vitest";
import {
  CheckoutItemSchema,
  CheckoutRawItemSchema,
  CheckoutPostBodySchema,
} from "@/lib/validation/schemas";

describe("CheckoutItemSchema", () => {
  it("accepts a valid item with productId", () => {
    const r = CheckoutItemSchema.safeParse({ productId: "abc", quantity: 2 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.quantity).toBe(2);
  });

  it("accepts a valid item with pgId only", () => {
    const r = CheckoutItemSchema.safeParse({ pgId: "pg-1" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.quantity).toBe(1); // default
  });

  it("rejects item without productId and pgId", () => {
    const r = CheckoutItemSchema.safeParse({ quantity: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects quantity above 10", () => {
    const r = CheckoutItemSchema.safeParse({ productId: "abc", quantity: 11 });
    expect(r.success).toBe(false);
  });

  it("rejects non-integer quantity", () => {
    const r = CheckoutItemSchema.safeParse({ productId: "abc", quantity: 1.5 });
    expect(r.success).toBe(false);
  });

  it("rejects quantity of 0", () => {
    const r = CheckoutItemSchema.safeParse({ productId: "abc", quantity: 0 });
    expect(r.success).toBe(false);
  });
});

describe("CheckoutPostBodySchema", () => {
  it("accepts body with items array", () => {
    const r = CheckoutPostBodySchema.safeParse({
      items: [{ productId: "p1", quantity: 1 }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts body with single product", () => {
    const r = CheckoutPostBodySchema.safeParse({ product: { pgId: "pg-9" } });
    expect(r.success).toBe(true);
  });

  it("rejects more than 50 items", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}` }));
    const r = CheckoutPostBodySchema.safeParse({ items });
    expect(r.success).toBe(false);
  });

  it("rejects invalid customer email", () => {
    const r = CheckoutPostBodySchema.safeParse({
      items: [{ productId: "p1" }],
      customer: { email: "not-an-email" },
    });
    expect(r.success).toBe(false);
  });

  it("passes through extra keys (passthrough)", () => {
    const r = CheckoutPostBodySchema.safeParse({
      items: [{ productId: "p1" }],
      attribution: { videoId: "v1" },
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).attribution).toBeDefined();
  });

  it("raw item coerces union types (string or number ids)", () => {
    const r = CheckoutRawItemSchema.safeParse({ productId: 123, quantity: "2" });
    expect(r.success).toBe(true);
  });
});
