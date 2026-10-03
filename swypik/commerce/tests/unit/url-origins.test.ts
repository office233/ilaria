import { describe, expect, it } from "vitest";
import { applicationRequestOrigins, parseConfiguredOrigin } from "@/lib/url-origins";

describe("configured application origins", () => {
  it("canonicalizes a valid HTTPS origin", () => {
    expect(parseConfiguredOrigin(" HTTPS://APP.SWYPIK.COM:443/ ")).toBe("https://app.swypik.com");
  });
  it.each([
    "https://user:pass@app.swypik.com", "https://app.swypik.com/path",
    "https://app.swypik.com/?token=secret", "https://app.swypik.com/#fragment",
    "https://*.swypik.com", "http://localhost:8081", "https://localhost:8081", "javascript:alert(1)", "http://app.swypik.com", "//app.swypik.com", "*", "",
  ])("rejects an unsafe/non-origin value %s", (value) => {
    expect(parseConfiguredOrigin(value)).toBeNull();
  });
  it.each(["http://localhost:8081", "http://127.0.0.1:3000", "http://[::1]:3000"])("permits loopback development %s", (value) => {
    expect(parseConfiguredOrigin(value, true)).toBe(value);
  });
  it("preserves the deployed app and www behavior", () => {
    expect(applicationRequestOrigins({ appUrl: "https://swypik.com", requestOrigin: "https://swypik.com" })).toEqual([
      "https://swypik.com", "https://www.swypik.com",
    ]);
  });
  it("does not implicitly trust the separate marketing domain", () => {
    const origins = applicationRequestOrigins({ appUrl: "https://app.swypik.com", requestOrigin: "https://api.swypik.com" });
    expect(origins).not.toContain("https://swypik.com");
    expect(origins).toContain("https://app.swypik.com");
    expect(origins).toContain("https://api.swypik.com");
  });
  it("only accepts exact valid explicit extra origins", () => {
    const origins = applicationRequestOrigins({ appUrl: "https://app.swypik.com", requestOrigin: "https://api.swypik.com", extraOrigins: "https://preview.swypik.com/, https://*.swypik.com/path, https://evil.test/?token=secret" });
    expect(origins).toContain("https://preview.swypik.com");
    expect(origins.some(origin => origin.includes("evil.test") || origin.includes("*"))).toBe(false);
  });
  it("preserves an explicit non-default port on the www alias", () => {
    expect(applicationRequestOrigins({ appUrl: "https://swypik.com:444", requestOrigin: "https://swypik.com:444" })).toContain("https://www.swypik.com:444");
  });
});
