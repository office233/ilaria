/**
 * Verificarea token-urilor de media (oglinda lui `lib/media/signed-media.ts`
 * din aplicație): `base64url(iv[12] | AES-256-GCM(payload) | tag[16])`,
 * cheia = SHA-256(secret). Payload: `{"v":1,"p":prefix,"e":expSec,"u"?:user}`.
 */

export type MediaToken = { prefix: string; expiresAt: number; userId?: string };

const TOKEN_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const keyCache = new Map<string, Promise<CryptoKey>>();

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(secret))
      .then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]));
    keyCache.set(secret, key);
  }
  return key;
}

export async function openToken(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<MediaToken | null> {
  if (!secret) return null;
  const raw = base64UrlToBytes(token);
  if (!raw || raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, IV_BYTES) }, await importKey(secret), raw.slice(IV_BYTES));
    const wire = JSON.parse(new TextDecoder().decode(plain)) as { v?: unknown; p?: unknown; e?: unknown; u?: unknown };
    if (wire.v !== TOKEN_VERSION || typeof wire.p !== "string" || typeof wire.e !== "number") return null;
    if (wire.e <= nowSeconds) return null;
    return { prefix: wire.p, expiresAt: wire.e, ...(typeof wire.u === "string" ? { userId: wire.u } : {}) };
  } catch {
    return null;
  }
}

/**
 * Cheia obiectului cerut: pentru un prefix-director, calea relativă (codată în
 * URL) se rezolvă strict în interiorul lui; pentru un obiect unic, calea e
 * cosmetică. null la orice traversare (`..`, `.`, segmente goale, `/` sau `\`
 * codate).
 */
export function resolveSignedKey(prefix: string, encodedRelative: string): string | null {
  if (!prefix || !encodedRelative) return null;
  if (!prefix.endsWith("/")) return prefix;
  const segments: string[] = [];
  for (const part of encodedRelative.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!decoded || decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) return null;
    segments.push(decoded);
  }
  return prefix + segments.join("/");
}
