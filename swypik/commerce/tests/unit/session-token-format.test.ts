import { describe, expect, it } from "vitest";
import { isSessionTokenFormat } from "@/lib/auth/session";

/**
 * Regresie pentru breșa critică din 2026-08-25: OTP-urile (salvate în
 * user_sessions cu session_token_hash = sha256("otp:"+cod)) puteau fi folosite
 * ca token de sesiune trimițând cookie-ul literal `swypik_session=otp:123456`.
 * Garda de format e prima linie de apărare — un token real e 64 hex.
 */
describe("isSessionTokenFormat", () => {
  it("acceptă un token de sesiune real (randomBytes(32).toString('hex') = 64 hex)", () => {
    const real = "a".repeat(64);
    expect(isSessionTokenFormat(real)).toBe(true);
  });

  it("RESPINGE forma de OTP folosită în exploit", () => {
    expect(isSessionTokenFormat("otp:123456")).toBe(false);
    expect(isSessionTokenFormat("otp:000000")).toBe(false);
  });

  it("respinge orice nu are exact 64 caractere hex", () => {
    expect(isSessionTokenFormat("")).toBe(false);
    expect(isSessionTokenFormat("a".repeat(63))).toBe(false);
    expect(isSessionTokenFormat("a".repeat(65))).toBe(false);
    expect(isSessionTokenFormat("Z".repeat(64))).toBe(false); // non-hex
    expect(isSessionTokenFormat(null)).toBe(false);
    expect(isSessionTokenFormat(undefined)).toBe(false);
  });

  it("acceptă hex real cu litere și cifre", () => {
    expect(isSessionTokenFormat("0123456789abcdef".repeat(4))).toBe(true);
  });
});
