import { parseConfiguredOrigin } from "@/lib/url-origins";

/**
 * URL-ul public al aplicației — sursă unică de adevăr.
 * NEXT_PUBLIC_APP_URL e inline-uit la build, deci merge și pe client.
 *
 * 2026-08-10 (audit P1): în producție, dacă lipsesc ambele variabile, folosim
 * fallback-ul dar logăm un warning (server-side) ca să nu treacă neobservat.
 */
const RESOLVED_APP_URL =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    null;

if (
    !RESOLVED_APP_URL &&
    process.env.NODE_ENV === "production" &&
    typeof window === "undefined"
) {
    // Dynamic import, not a top-level one: this module is also imported from
    // client bundles (NEXT_PUBLIC_APP_URL must work in the browser), and
    // lib/logger pulls in pino, which is server-only. A static import here
    // would drag pino into the client bundle even though this branch never
    // runs there.
    import("@/lib/logger")
        .then(({ logger }) =>
            logger.error(
                "[app-url] NEXT_PUBLIC_APP_URL/APP_URL lipsesc în producție — se folosește fallback-ul https://swypik.com. Link-urile din email/OAuth pot fi greșite pe staging.",
            ),
        )
        .catch(() => {
            /* logging is best-effort here */
        });
}

export const APP_URL = (
    RESOLVED_APP_URL || "https://swypik.com"
).replace(/\/$/, "");

/** Public presentation site; configuring it does not grant API/CSRF access. */
export const SITE_URL = configuredPublicOrigin(
    process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL,
    "NEXT_PUBLIC_SITE_URL/SITE_URL",
);

/** Defaults to the current Next.js origin until the common API gateway is ready. */
export const API_URL = configuredPublicOrigin(
    process.env.NEXT_PUBLIC_API_URL,
    "NEXT_PUBLIC_API_URL",
);

function configuredPublicOrigin(value: string | undefined, name: string): string {
    if (!value) return APP_URL;
    const origin = parseConfiguredOrigin(value, process.env.NODE_ENV === "development");
    if (!origin) throw new Error(`[app-url] ${name} must be a valid HTTPS origin (HTTP loopback is development-only)`);
    return origin;
}
