/**
 * URL-uri canonice și de request, centralizate.
 *
 * Regula: în producție nu folosim niciodată "localhost" ca fallback —
 * cădem pe domeniul canonic și logăm un avertisment, ca să nu ajungă
 * link-uri rupte în canonical/OG sau în fetch-urile SSR.
 */
import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";

/** Domeniul canonic public, folosit când nu există nicio configurație explicită. */
export const CANONICAL_APP_URL = APP_URL;

const isProd = process.env.NODE_ENV === "production";

function normalize(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Base URL public al aplicației (pentru canonical, OG, link-uri din emailuri).
 * Ordine: NEXT_PUBLIC_APP_URL → NEXT_PUBLIC_BASE_URL → localhost (doar dev) → domeniu canonic.
 */
export function getAppBaseUrl(): string {
    const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_BASE_URL;
    if (configured) return normalize(configured);

    if (!isProd) return "http://localhost:3000";

    logger.warn(
        { fallback: CANONICAL_APP_URL },
        "NEXT_PUBLIC_APP_URL/NEXT_PUBLIC_BASE_URL lipsesc în producție; folosesc domeniul canonic."
    );
    return CANONICAL_APP_URL;
}

/**
 * Base URL derivat din headerele request-ului, pentru fetch-uri SSR către propriul API.
 * Cade pe {@link getAppBaseUrl} când headerele lipsesc (nu pe "localhost" în producție).
 */
export function getRequestBaseUrl(h: Headers): string {
    const host = h.get("x-forwarded-host") || h.get("host");
    if (!host) return getAppBaseUrl();
    const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
}
