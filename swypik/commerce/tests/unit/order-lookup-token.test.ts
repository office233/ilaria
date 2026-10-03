import { describe, expect, it } from "vitest";
import {
  generateOrderLookupToken,
  isOrderLookupToken,
} from "@/lib/shop/order-lookup-token";

describe("order lookup capability token", () => {
  it("uses 192 bits of CSPRNG entropy encoded as 48 hex chars", () => {
    const token = generateOrderLookupToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(Buffer.from(token, "hex")).toHaveLength(24);
    expect(isOrderLookupToken(token)).toBe(true);
  });

  it("does not repeat across a practical sample", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateOrderLookupToken));
    expect(tokens.size).toBe(1000);
  });

  it("rejects weak or malformed values", () => {
    expect(isOrderLookupToken("tok123")).toBe(false);
    expect(isOrderLookupToken("a".repeat(32))).toBe(false);
    expect(isOrderLookupToken("G".repeat(48))).toBe(false);
  });
});
