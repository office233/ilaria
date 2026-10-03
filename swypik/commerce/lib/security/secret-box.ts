/**
 * Criptare simetrică pentru secrete stocate în DB (AES-256-GCM).
 * Cheia derivă din APP_ENCRYPTION_KEY (32 bytes hex) cu separare pe scop,
 * ca un secret criptat pentru un scop să nu poată fi decriptat în altul.
 * Format: "v1:iv:tag:ciphertext" (hex).
 */
import crypto from "node:crypto";

function masterKey(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY || "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("APP_ENCRYPTION_KEY missing or invalid (expected 32-byte hex)");
  }
  return Buffer.from(hex, "hex");
}

function purposeKey(purpose: string): Buffer {
  return crypto.createHmac("sha256", masterKey()).update(`secret-box:${purpose}`).digest();
}

export function encryptSecret(purpose: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", purposeKey(purpose), iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(purpose: string, stored: string): string {
  const [version, ivHex, tagHex, dataHex] = stored.split(":");
  if (version !== "v1" || !ivHex || !tagHex || !dataHex) throw new Error("invalid encrypted secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", purposeKey(purpose), Buffer.from(ivHex, "hex"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** HMAC derivat server-side (cheie = APP_ENCRYPTION_KEY pe scop). */
export function deriveServerSecret(purpose: string, input: string): string {
  return crypto.createHmac("sha256", purposeKey(purpose)).update(input).digest("hex");
}
