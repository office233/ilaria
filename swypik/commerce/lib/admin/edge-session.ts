/**
 * Verificarea timpurie a cookie-ului `admin_token` în middleware (runtime edge:
 * fără `node:crypto`, fără DB).
 *
 * 1. Formă: tokenurile emise de createAdminSessionAndGetCookie sunt 32 de octeți
 *    hex (64 caractere). Orice altceva (ex. `admin_token=probe`) e respins fără I/O.
 * 2. Server-side: GET intern la /api/admin/session (Node, DB) — 401 = sesiune
 *    inexistentă/expirată/revocată → respins. Rezultatele pozitive se țin
 *    SESSION_CACHE_MS în memorie, ca navigarea în consolă să nu dubleze
 *    fiecare cerere. Dacă verificarea nu răspunde (timeout/rețea), cererea
 *    trece mai departe: requireAdminPage din fiecare pagină rămâne garda reală.
 */

export const ADMIN_TOKEN_RE = /^[0-9a-f]{64}$/;
const SESSION_CACHE_MS = 30_000;
const CACHE_MAX = 500;
const CHECK_TIMEOUT_MS = 1_500;

export type AdminSessionVerdict = "valid" | "invalid" | "unknown";

const validUntil = new Map<string, number>();

export function isWellFormedAdminToken(token: string | undefined | null): token is string {
  return typeof token === "string" && ADMIN_TOKEN_RE.test(token);
}

/** Originea internă a aplicației (același proces Next), nu URL-ul public. */
export function adminSessionCheckUrl(env: Record<string, string | undefined> = process.env): string {
  const origin = env.ADMIN_SESSION_CHECK_ORIGIN?.trim() || `http://127.0.0.1:${env.PORT || "3000"}`;
  return `${origin.replace(/\/$/, "")}/api/admin/session`;
}

export function resetAdminSessionCache(): void {
  validUntil.clear();
}

export async function verifyAdminSession(
  token: string,
  opts: { fetchImpl?: typeof fetch; now?: number; url?: string } = {},
): Promise<AdminSessionVerdict> {
  if (!isWellFormedAdminToken(token)) return "invalid";
  const now = opts.now ?? Date.now();
  const cached = validUntil.get(token);
  if (cached && cached > now) return "valid";
  validUntil.delete(token);

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await doFetch(opts.url ?? adminSessionCheckUrl(), {
      method: "GET",
      headers: { cookie: `admin_token=${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return "invalid";
    if (!res.ok) return "unknown";
    if (validUntil.size >= CACHE_MAX) validUntil.clear();
    validUntil.set(token, now + SESSION_CACHE_MS);
    return "valid";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
