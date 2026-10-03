/**
 * Link-uri semnate, de scurtă durată, pentru fișierele sellerului (PDF factură,
 * XML e-Factura, bon POS, etichetă AWB).
 *
 * În aplicația mobilă (WebView Capacitor) descărcarea nu merge din pagină, deci
 * fișierul se deschide în browserul sistemului / foaia de partajare — acolo nu
 * există cookie-ul de sesiune al sellerului. Token-ul din URL (HMAC, legat de
 * seller + tip + id, expiră în câteva minute) ține locul sesiunii doar pentru
 * acel fișier.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getStreamSecret } from "@/lib/media/stream-secret";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { sellerRequestLocale } from "./request-locale";
import { SELLER_FILE_KINDS, sellerFilePath, type SellerFileKind } from "./file-paths";

export { SELLER_FILE_KINDS, sellerFilePath, type SellerFileKind };

/** Cât trăiește un link semnat (implicit 10 minute). */
export function sellerFileLinkTtlMs(): number {
  const n = Number(process.env.SELLER_FILE_LINK_TTL_SECONDS);
  return (Number.isFinite(n) && n >= 30 && n <= 3600 ? Math.trunc(n) : 600) * 1000;
}

type Payload = { s: string; k: SellerFileKind; i: string; e: number };

function sign(body: string): string {
  return createHmac("sha256", `seller-file:${getStreamSecret()}`).update(body).digest("base64url");
}

export function signSellerFileToken(sellerId: string, kind: SellerFileKind, id: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ s: sellerId, k: kind, i: id, e: now + sellerFileLinkTtlMs() })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Sellerul pentru care a fost emis token-ul, dacă e valid pentru exact (kind, id). */
export function verifySellerFileToken(token: string, kind: SellerFileKind, id: string, now = Date.now()): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Payload>;
    if (p.k !== kind || p.i !== id || typeof p.s !== "string" || typeof p.e !== "number" || p.e <= now) return null;
    return p.s;
  } catch {
    return null;
  }
}

/** Sellerul care cere fișierul: sesiunea (browser/WebView) sau token-ul semnat (browser extern). */
export async function resolveSellerForFile(req: Request, kind: SellerFileKind, id: string): Promise<string | null> {
  const token = new URL(req.url).searchParams.get("t");
  if (token) return verifySellerFileToken(token, kind, id);
  return getSellerSessionId();
}

/** Limba documentului: `?locale=` (link semnat, fără cookie) sau cookie-ul de locale. */
export async function sellerFileLocale(req: Request): Promise<Locale> {
  const fromUrl = new URL(req.url).searchParams.get("locale");
  return isLocale(fromUrl) ? fromUrl : sellerRequestLocale();
}

/** Antetele unui fișier descărcabil: nume ASCII + UTF-8 (RFC 6266), fără cache. */
export function fileHeaders(contentType: string, filename: string, disposition: "inline" | "attachment"): HeadersInit {
  const ascii = filename.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "document";
  return {
    "Content-Type": contentType,
    "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
