/**
 * Simple Redis-backed sliding-window rate limit + idempotency helpers.
 */
import { getRedis } from "@/lib/redis";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // seconds
}

/**
 * Fixed-window counter: max N requests per windowSec for a given key.
 */
export async function rateLimit(
  key: string,
  max: number,
  windowSec: number
): Promise<RateLimitResult> {
  try {
    const redis = getRedis();
    const redisKey = `rl:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSec);
    }
    if (count > max) {
      const ttl = await redis.ttl(redisKey);
      return { ok: false, remaining: 0, retryAfter: ttl > 0 ? ttl : windowSec };
    }
    return { ok: true, remaining: Math.max(0, max - count), retryAfter: 0 };
  } catch (err) {
    // Fail-open if Redis unavailable.
    return { ok: true, remaining: max, retryAfter: 0 };
  }
}

export async function idempotencyGet<T = any>(key: string): Promise<T | null> {
  try {
    const redis = getRedis();
    const cached = await redis.get(`idem:${key}`);
    if (!cached) return null;
    return JSON.parse(cached) as T;
  } catch {
    return null;
  }
}

export async function idempotencySet(
  key: string,
  value: unknown,
  ttlSec = 300
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(`idem:${key}`, JSON.stringify(value), "EX", ttlSec);
  } catch {
    /* ignore */
  }
}

/**
 * Rezervă atomic cheia de idempotență (SET NX). Întoarce `true` doar pentru
 * primul apelant — ceilalți trebuie să aștepte/reia rezultatul, ca două cereri
 * concurente să nu execute amândouă operația în fereastra get-then-set.
 */
export async function idempotencyClaim(key: string, ttlSec = 300): Promise<boolean> {
  try {
    const redis = getRedis();
    const res = await redis.set(`idem:claim:${key}`, "1", "EX", ttlSec, "NX");
    return res === "OK";
  } catch {
    // Fail-open: fără Redis nu blocăm vânzarea.
    return true;
  }
}

/** Eliberează rezervarea (la eroare, ca retry-ul clientului să poată relua). */
export async function idempotencyRelease(key: string): Promise<void> {
  try {
    await getRedis().del(`idem:claim:${key}`);
  } catch {
    /* ignore */
  }
}

export function clientIp(req: Request): string {
  const h = req.headers;
  if (!h) return "unknown";
  // Preferăm X-Real-IP: ingress-ul îl suprascrie cu adresa reală a conexiunii,
  // deci nu e spoofabil. Garantul e `cloudflared` de la dezactivarea lui Caddy
  // — vezi explicația detaliată și dovada empirică din
  // lib/security/rate-limit.ts (getClientIP), sursa de adevăr pentru premisa
  // asta. Helperul de acolo e folosit în 43 de fișiere; ăsta, în 7. Pentru cod
  // nou preferă `getClientIP` — sunt logic identici, iar duplicarea e istorică.
  const real = h.get?.("x-real-ip");
  if (real) return String(real).trim();
  // Fallback: ULTIMUL hop din XFF (cel mai apropiat de proxy-ul de încredere),
  // niciodată primul — pe acela un atacator îl poate prefixa.
  const xff = h.get?.("x-forwarded-for") || h.get?.("X-Forwarded-For");
  if (xff) {
    const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "unknown";
}
