import { describe, expect, it } from "vitest";
import { decimalToCents, decimalToMinorUnits } from "@/lib/money/decimal";

describe("decimal money parser", () => {
  it("parses exact two-decimal values without floating point arithmetic", () => {
    expect(decimalToCents("10.10")).toBe(1010);
    expect(decimalToCents("0.29")).toBe(29);
    expect(decimalToCents(1000.01)).toBe(100001);
    expect(decimalToCents("1")).toBe(100);
    expect(decimalToCents("1.5")).toBe(150);
  });

  it("rejects implicit rounding, signs and malformed values", () => {
    expect(decimalToCents("1.005")).toBeNull();
    expect(decimalToCents("-1.00")).toBeNull();
    expect(decimalToCents("1,50")).toBeNull();
    expect(decimalToCents(Number.NaN)).toBeNull();
  });

  it("supports other decimal scales safely", () => {
    expect(decimalToMinorUnits("1.2345", 4)).toBe(12345);
    expect(decimalToMinorUnits("1.23456", 4)).toBeNull();
  });
});
