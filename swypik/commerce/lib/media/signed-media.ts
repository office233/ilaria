/**
 * URL-uri semnate pentru media privată/plătită servită DIRECT de pe CDN
 * (Cloudflare Worker `infra/cloudflare/media-worker` legat de bucket-ul R2).
 * Niciun byte de media nu trece prin serverul aplicației.
 *
 * Forma: `<MEDIA_SIGNED_BASE_URL>/s/<token>/<cale relativă>`
 *   - token = AES-256-GCM(cheie = SHA-256(MEDIA_SIGNING_SECRET)) peste
 *     `{"v":1,"p":<prefix sau cheie>,"e":<expirare, secunde unix>,"u":<user>}`,
 *     codat `base64url(iv[12] | ciphertext | tag[16])`. Criptat (nu doar semnat):
 *     clientul nu află cheia reală a obiectului (basename-ul aleator al pieselor
 *     premium rămâne secret), iar orice modificare invalidează token-ul.
 *   - `p` terminat în `/` = director (episod HLS): calea relativă se rezolvă în
 *     el, deci playlist-urile cu URI-uri relative merg fără rescriere și fără
 *     re-semnarea fiecărui segment. Altfel `p` e un singur obiect (piesă audio)
 *     și calea relativă e doar cosmetică.
 * Formatul e oglindit în `infra/cloudflare/media-worker/src/token.ts` (test comun).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { firstEnv, mediaPublicBaseUrl } from "@/lib/storage/config";

export const SIGNED_MEDIA_PATH_PREFIX = "/s/";
const TOKEN_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type MediaTokenPayload = {
    /** Prefixul (director, terminat în `/`) sau cheia exactă a obiectului. */
    prefix: string;
    /** Expirarea absolută, secunde unix. */
    expiresAt: number;
    userId?: string;
};

type WirePayload = { v: number; p: string; e: number; u?: string };

function deriveKey(secret: string): Buffer {
    return createHash("sha256").update(secret, "utf8").digest();
}

export function sealMediaToken(payload: MediaTokenPayload, secret: string): string {
    const wire: WirePayload = { v: TOKEN_VERSION, p: payload.prefix, e: payload.expiresAt, ...(payload.userId ? { u: payload.userId } : {}) };
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(wire), "utf8"), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** Inversul lui `sealMediaToken` (pentru teste și diagnoză); null la orice problemă. */
export function openMediaToken(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): MediaTokenPayload | null {
    let raw: Buffer;
    try {
        raw = Buffer.from(token, "base64url");
    } catch {
        return null;
    }
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    try {
        const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
        const text = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
        const wire = JSON.parse(text) as Partial<WirePayload>;
        if (wire.v !== TOKEN_VERSION || typeof wire.p !== "string" || typeof wire.e !== "number") return null;
        if (wire.e <= nowSeconds) return null;
        return { prefix: wire.p, expiresAt: wire.e, ...(typeof wire.u === "string" ? { userId: wire.u } : {}) };
    } catch {
        return null;
    }
}

export function mediaSigningSecret(): string {
    return firstEnv(["MEDIA_SIGNING_SECRET"]);
}

/** Originea URL-urilor semnate (domeniul CDN cu Worker-ul); implicit baza publică. */
export function mediaSignedBaseUrl(): string {
    return (firstEnv(["MEDIA_SIGNED_BASE_URL"]) || mediaPublicBaseUrl()).replace(/\/+$/, "");
}

export function isMediaSigningConfigured(): boolean {
    return Boolean(mediaSigningSecret() && mediaSignedBaseUrl());
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

/** Directorul unei chei (`a/b/master.m3u8` → `a/b/`) și numele fișierului. */
export function splitObjectKey(key: string): { dir: string; name: string } {
    const i = key.lastIndexOf("/");
    return { dir: key.slice(0, i + 1), name: key.slice(i + 1) };
}

export type SignedMediaRequest = {
    /** Cheia obiectului cerut primul (ex. `private/videos/hls/x/master.m3u8`). */
    key: string;
    /** `directory` = acces la tot directorul cheii (HLS); `object` = doar cheia (audio). */
    scope: "directory" | "object";
    /** Expirare absolută, ms (ca token-urile de stream existente). */
    expiresAtMs: number;
    userId?: string;
    /** Pentru `object`: numele cosmetic din URL (implicit basename-ul NU se expune). */
    displayName?: string;
};

/** URL-ul semnat, sau null dacă semnarea nu e configurată. */
export function signedMediaUrl(req: SignedMediaRequest): string | null {
    const secret = mediaSigningSecret();
    const base = mediaSignedBaseUrl();
    if (!secret || !base) return null;
    const { dir, name } = splitObjectKey(req.key);
    const prefix = req.scope === "directory" ? dir : req.key;
    const relative = req.scope === "directory" ? name : req.displayName || "media";
    const token = sealMediaToken({ prefix, expiresAt: Math.ceil(req.expiresAtMs / 1000), userId: req.userId }, secret);
    return `${base}${SIGNED_MEDIA_PATH_PREFIX}${token}/${encodePath(relative)}`;
}

/**
 * Proxy-ul de bytes din app (`/api/{movies,music}/stream`) e DOAR pentru
 * dezvoltare (MinIO local, fără Worker). În producție e oprit, cu excepția
 * unei suprascrieri explicite de urgență (MEDIA_SERVER_PROXY=1).
 */
export function isServerMediaProxyAllowed(): boolean {
    if (process.env.MEDIA_SERVER_PROXY === "1") return true;
    return process.env.NODE_ENV !== "production";
}
