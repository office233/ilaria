/**
 * Verificarea semnăturii webhook-urilor RealtimeKit
 * (https://developers.cloudflare.com/realtime/realtimekit/webhooks/):
 * antetul `rtk-signature` = base64(RSA-SHA256(corpul brut)), cheie publică PEM
 * din CF_REALTIMEKIT_WEBHOOK_PUBLIC_KEY sau de la URL-ul public documentat
 * (cache în memorie — e doar o cheie publică, sigur de ținut per proces).
 */
import { createPublicKey, verify, type KeyObject } from "crypto";
import { logger } from "@/lib/logger";
import { realtimeHttpTimeoutMs, rtkWebhookKeyUrl, rtkWebhookPublicKeyFromEnv } from "./config";

const KEY_CACHE_MS = 6 * 3600 * 1000;
const KEY_REFRESH_MIN_MS = 5 * 60 * 1000;
let cached: { key: KeyObject; at: number } | null = null;

/** Normalizează un PEM care poate veni cu `\n` literale sau fără antete. */
export function normalizePem(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  if (text.includes("BEGIN PUBLIC KEY")) return text;
  const body = text.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

async function fetchPublicKeyPem(): Promise<string> {
  const res = await fetch(rtkWebhookKeyUrl(), { signal: AbortSignal.timeout(realtimeHttpTimeoutMs()), cache: "no-store" });
  if (!res.ok) throw new Error(`webhook key fetch failed: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { publicKey?: string } };
  const pem = json.data?.publicKey;
  if (!pem) throw new Error("webhook key missing in response");
  return pem;
}

export async function getRtkWebhookKey(opts: { refresh?: boolean } = {}): Promise<KeyObject> {
  const fromEnv = rtkWebhookPublicKeyFromEnv();
  if (fromEnv) return createPublicKey(normalizePem(fromEnv));
  if (!opts.refresh && cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.key;
  const key = createPublicKey(normalizePem(await fetchPublicKeyPem()));
  cached = { key, at: Date.now() };
  return key;
}

/** Doar pentru teste. */
export function resetRtkWebhookKeyCache(): void {
  cached = null;
}

export function verifyWithKey(rawBody: string, signatureB64: string, key: KeyObject): boolean {
  try {
    return verify("sha256", Buffer.from(rawBody, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * true doar dacă semnătura e validă. La eșec cu o cheie din cache, reîncearcă o
 * dată cu cheia proaspătă (rotire de cheie la Cloudflare).
 */
export async function verifyRtkSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  try {
    if (verifyWithKey(rawBody, signature, await getRtkWebhookKey())) return true;
    // Fără refetch la fiecare semnătură greșită (ar fi un amplificator de cereri).
    if (rtkWebhookPublicKeyFromEnv() || !cached || Date.now() - cached.at < KEY_REFRESH_MIN_MS) return false;
    return verifyWithKey(rawBody, signature, await getRtkWebhookKey({ refresh: true }));
  } catch (err) {
    logger.warn({ err }, "[realtime/rtk-webhook] public key unavailable");
    return false;
  }
}
