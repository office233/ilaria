import { describe, expect, it } from "vitest";
import { moneyMagnitudeToCents, moneyToCents } from "@/lib/seller/imports/common";

describe("provider price decimal rounding", () => {
  it.each([["1.005", 101], [1.005, 101], ["1.255", 126], ["2.675", 268], ["0.004999", 0], ["0.005001", 1]])
    ("rounds %s deterministically to %s cents", (amount, cents) => expect(moneyToCents(amount)).toBe(cents));
  it("keeps safe integer cent amounts exact and refuses overflow", () => {
    expect(moneyToCents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(moneyToCents("90071992547409.92")).toBeNull();
  });
  it.each(["", " ", "0x10", "-1", "Infinity", "1.1234567", Infinity, NaN])("rejects invalid price %s", (amount) => {
    expect(moneyToCents(amount)).toBeNull();
  });
  it("uses the same exact rounding for signed refund amounts", () => {
    expect(moneyMagnitudeToCents("-1.005")).toBe(101);
    expect(moneyMagnitudeToCents(-1.005)).toBe(101);
    expect(moneyMagnitudeToCents(" ")).toBeNull();
    expect(moneyMagnitudeToCents("0x10")).toBeNull();
  });
});
