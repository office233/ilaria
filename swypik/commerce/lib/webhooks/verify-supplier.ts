/**
 * Supplier webhook signature & replay verification.
 *
 * Expects:
 *   - `X-Signature` header: hex-encoded HMAC-SHA256(SUPPLIER_WEBHOOK_SECRET, `${timestamp}.${rawBody}`)
 *     Legacy: bare HMAC over rawBody also accepted while clients migrate.
 *   - `X-Timestamp` header: unix seconds. Refused if outside ±300s drift.
 *   - Replay protection: stores `webhook:supplier:<sig>` in Redis for 600s.
 */

import crypto from "crypto";
import { getRedis } from "@/lib/redis";

export type SupplierVerifyResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

const MAX_DRIFT_SEC = 300;
const REPLAY_TTL_SEC = 600;

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export async function verifySupplierWebhook(
  req: Request,
  rawBody: string
): Promise<SupplierVerifyResult> {
  const secret = process.env.SUPPLIER_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, status: 503, error: "Webhook not configured" };
  }

  const signature = (req.headers.get("x-signature") || "").trim().toLowerCase();
  const timestampHeader = req.headers.get("x-timestamp") || "";

  if (!signature) {
    return { ok: false, status: 401, error: "Missing signature" };
  }

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, status: 401, error: "Missing or invalid timestamp" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_DRIFT_SEC) {
    return { ok: false, status: 401, error: "Timestamp outside accepted window" };
  }

  // Canonical signature: HMAC(secret, `${ts}.${rawBody}`).
  const expectedV2 = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  // Legacy signature: HMAC(secret, rawBody) — accepted during migration.
  const expectedV1 = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  if (!safeEqualHex(signature, expectedV2) && !safeEqualHex(signature, expectedV1)) {
    return { ok: false, status: 403, error: "Bad signature" };
  }

  // Replay protection: refuse if we've seen this signature within the window.
  try {
    const redis = getRedis();
    const key = `webhook:supplier:${signature}`;
    // SET NX EX
    const setRes = await redis.set(key, "1", "EX", REPLAY_TTL_SEC, "NX");
    if (setRes === null) {
      return { ok: false, status: 409, error: "Replay detected" };
    }
  } catch {
    // Fail-closed on replay store failure to avoid silent double-fulfillment.
    return { ok: false, status: 503, error: "Replay store unavailable" };
  }

  return { ok: true };
}
