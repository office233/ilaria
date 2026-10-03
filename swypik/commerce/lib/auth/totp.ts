import * as OTPAuth from "otpauth";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { logger } from "@/lib/logger";

const ISSUER = "Swypik";

/* ────────────────────────────────────────────────────────────────────
 * Encryption helpers for TOTP secret at rest.
 * AES-256-GCM with random IV per record. Format:
 *   v1:<ivHex>:<tagHex>:<ciphertextHex>
 * Backward compat: any value that does NOT start with "v1:" is treated
 * as plaintext base32 (legacy). decryptSecret returns it as-is.
 * ──────────────────────────────────────────────────────────────────── */
function getKey(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("APP_ENCRYPTION_KEY missing or invalid (expected 32-byte hex)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return stored;
  if (!stored.startsWith("v1:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) return stored;
  try {
    const key = getKey();
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const data = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

export function generateSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function getOtpAuthUrl(secret: string, email: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.toString();
}

/**
 * Verify a TOTP code. `storedSecret` may be encrypted (v1:...) or legacy plaintext.
 */
export function verifyToken(storedSecret: string, token: string): boolean {
  try {
    const secret = decryptSecret(storedSecret);
    if (!secret) return false;
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const delta = totp.validate({ token: token.replace(/\s/g, ""), window: 1 });
    return delta !== null;
  } catch {
    return false;
  }
}

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString("hex").toUpperCase());
  }
  return codes;
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  // bcrypt cost 12
  return Promise.all(codes.map((c) => bcrypt.hash(c, 12)));
}

export async function consumeBackupCode(
  hashedList: string[],
  submitted: string,
): Promise<{ matched: boolean; remaining: string[] }> {
  const clean = submitted.replace(/\s/g, "").toUpperCase();
  for (let i = 0; i < hashedList.length; i++) {
    const h = hashedList[i];
    if (typeof h !== "string" || !/^\$2[aby]\$/.test(h)) continue;
    try {
      if (await bcrypt.compare(clean, h)) {
        const remaining = hashedList.filter((_, idx) => idx !== i);
        return { matched: true, remaining };
      }
    } catch (err) {
      // 2026-08-10 (audit P1): hash corupt în DB blochează userul silențios —
      // logăm pentru diagnostic (fără date sensibile).
      logger.warn({ err, index: i }, "[2fa] bcrypt.compare failed on backup code hash");
    }
  }
  return { matched: false, remaining: hashedList };
}
