/**
 * Dezabonarea de la emailurile de marketing.
 *
 *  - Linkul din email duce la pagina de CONFIRMARE (`/unsubscribe?u=…&t=…`);
 *    un GET nu dezabonează nimic (scannerele de linkuri deschid tot).
 *  - Dezabonarea propriu-zisă e un POST: formularul de pe pagină sau
 *    one-click-ul RFC 8058 din antetul `List-Unsubscribe` (`/api/unsubscribe`).
 *  - Adresa călătorește ca base64url (`u`), nu în clar, și e legată de un HMAC.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { APP_URL } from "@/lib/app-url";
import type { Locale } from "@/lib/i18n/config";

function secret(): string {
  const s = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    // Fail-loud în producție — un fallback public ar permite forjarea
    // tokenurilor de dezabonare pentru orice adresă.
    throw new Error("APP_ENCRYPTION_KEY/SESSION_SECRET lipsesc în producție — refuz tokenurile de dezabonare.");
  }
  return "swypik-unsubscribe-fallback";
}

export function unsubscribeToken(email: string): string {
  return createHmac("sha256", secret()).update(email.toLowerCase()).digest("hex").slice(0, 32);
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function encodeEmailParam(email: string): string {
  return Buffer.from(email.toLowerCase(), "utf8").toString("base64url");
}

export function decodeEmailParam(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const email = Buffer.from(value, "base64url").toString("utf8");
    return email.includes("@") && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

/** Pagina de confirmare (linkul vizibil din footer-ul emailurilor de marketing). */
export function unsubscribeUrl(email: string, locale?: Locale): string {
  const url = new URL(`${APP_URL}/unsubscribe`);
  url.searchParams.set("u", encodeEmailParam(email));
  url.searchParams.set("t", unsubscribeToken(email));
  if (locale) url.searchParams.set("l", locale);
  return url.toString();
}

/** Endpoint-ul one-click (RFC 8058) pentru antetul `List-Unsubscribe`. */
export function oneClickUnsubscribeUrl(email: string): string {
  const url = new URL(`${APP_URL}/api/unsubscribe`);
  url.searchParams.set("u", encodeEmailParam(email));
  url.searchParams.set("t", unsubscribeToken(email));
  return url.toString();
}
