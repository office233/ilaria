/**
 * Token de acces pentru comenzile Food plasate fără cont.
 * Clientul primește token-ul o singură dată (la plasare); în DB stă doar
 * sha256-ul (local_orders.guest_token_hash, migrarea 20260926_0032).
 */
import crypto from "crypto";

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function newGuestToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, hash: hashGuestToken(token) };
}

export function hashGuestToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Compară în timp constant; format invalid sau hash lipsă → false. */
export function guestTokenMatches(token: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!token || !storedHash || !TOKEN_RE.test(token)) return false;
  const a = Buffer.from(hashGuestToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Token-ul din request: header `x-order-token` sau query `?t=`. */
export function guestTokenFromRequest(req: Request): string | null {
  const h = req.headers.get("x-order-token");
  if (h) return h;
  try {
    return new URL(req.url).searchParams.get("t");
  } catch {
    return null;
  }
}
