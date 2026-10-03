import { afterEach, describe, expect, it } from "vitest";
import { intEnv } from "@/lib/config/env";

const KEY = "SWYPIK_TEST_INT_ENV";

afterEach(() => {
  delete process.env[KEY];
});

describe("intEnv", () => {
  it("uses fallback for missing, blank and invalid values", () => {
    expect(intEnv(KEY, 7, 1, 10)).toBe(7);
    process.env[KEY] = "   ";
    expect(intEnv(KEY, 7, 1, 10)).toBe(7);
    process.env[KEY] = "invalid";
    expect(intEnv(KEY, 7, 1, 10)).toBe(7);
  });

  it("truncates and clamps to declared bounds", () => {
    process.env[KEY] = "5.9";
    expect(intEnv(KEY, 7, 1, 10)).toBe(5);
    process.env[KEY] = "999";
    expect(intEnv(KEY, 7, 1, 10)).toBe(10);
    process.env[KEY] = "-4";
    expect(intEnv(KEY, 7, 1, 10)).toBe(1);
  });
});
