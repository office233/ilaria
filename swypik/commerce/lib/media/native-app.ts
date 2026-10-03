/**
 * Detectarea shell-ului nativ (viitoarele aplicații Capacitor iOS/Android).
 *
 * Regulile App Store (3.1.1) și Google Play (Payments policy) cer ca
 * conținutul DIGITAL deblocat în aplicație (episoade Movies, piese/albume
 * Music) să fie cumpărat prin IAP-ul platformei. Până la integrarea IAP,
 * build-urile native ascund cumpărarea deblocărilor digitale (web-ul rămâne
 * neschimbat); bunurile fizice și serviciile reale (Stays, comenzi) nu intră
 * sub această regulă.
 *
 * Contract pentru shell-ul Capacitor (documentat și în docs/mobile/native-shell.md):
 *   - user-agent-ul WebView-ului conține `swypik-native` (ex. `appendUserAgent`
 *     în capacitor.config: `"swypik-native/1.0 (ios)"`), ȘI/SAU
 *   - antetul `x-swypik-native: 1` pe cererile către API, ȘI/SAU
 *   - cookie-ul `swypik_native=1` (setat de shell la pornire, pentru SSR).
 * Oricare dintre ele e suficient. Fără dependențe Node: se importă și din client.
 */
export const NATIVE_APP_UA_TOKEN = "swypik-native";
export const NATIVE_APP_HEADER = "x-swypik-native";
export const NATIVE_APP_COOKIE = "swypik_native";
/** Codul de eroare al rutelor de deblocare apelate din aplicația nativă. */
export const PURCHASE_UNAVAILABLE_IN_APP = "purchase_unavailable_in_app";

type HeaderSource = { get(name: string): string | null };

function cookieFlag(cookieHeader: string | null | undefined): boolean {
    if (!cookieHeader) return false;
    return cookieHeader.split(";").some((part) => {
        const [name, value] = part.trim().split("=");
        return name === NATIVE_APP_COOKIE && value === "1";
    });
}

/** Din anteturile unei cereri (rute API, server components cu `headers()`). */
export function isNativeAppHeaders(headers: HeaderSource): boolean {
    if (headers.get(NATIVE_APP_HEADER) === "1") return true;
    if ((headers.get("user-agent") ?? "").toLowerCase().includes(NATIVE_APP_UA_TOKEN)) return true;
    return cookieFlag(headers.get("cookie"));
}

export function isNativeAppRequest(req: Request): boolean {
    return isNativeAppHeaders(req.headers);
}

/** În browser (componente client). `false` pe server. */
export function isNativeAppClient(): boolean {
    if (typeof navigator === "undefined" || typeof document === "undefined") return false;
    return navigator.userAgent.toLowerCase().includes(NATIVE_APP_UA_TOKEN) || cookieFlag(document.cookie);
}
