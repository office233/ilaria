import crypto from "node:crypto";

export function verifyBase64HmacSha256(
  rawBody: string,
  provided: string | null,
  secret: string,
): boolean {
  if (!provided || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(provided.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function payloadSha256(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
}
