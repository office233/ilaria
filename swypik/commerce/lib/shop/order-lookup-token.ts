import crypto from "node:crypto";

/** 24 random bytes = 192 bits of entropy, encoded as 48 lowercase hex chars. */
export function generateOrderLookupToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function isOrderLookupToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{48}$/.test(value);
}
