/**
 * Configurația storage-ului de media — O SINGURĂ sursă pentru orice backend
 * S3-compatibil: MinIO local, Cloudflare R2 în producție (vezi docs/infra/r2.md).
 *
 * Fără dependențe Node: se importă și din middleware (edge), pentru CSP.
 *
 * Variabile canonice (alias-urile istorice rămân acceptate, în ordinea din listă):
 *   S3_ENDPOINT            endpointul S3 văzut de server (R2: https://<cont>.r2.cloudflarestorage.com)
 *   S3_REGION              `auto` pentru R2
 *   S3_BUCKET              bucket-ul de media
 *   S3_ACCESS_KEY / S3_SECRET_KEY
 *   S3_PRESIGN_ENDPOINT    endpointul S3 pe care se semnează URL-urile folosite DIN BROWSER
 *                          (upload direct); implicit S3_ENDPOINT
 *   MEDIA_PUBLIC_BASE_URL  originea CDN publică (ex. https://media.swypik.com) — baza
 *                          tuturor URL-urilor publice de media
 */

export const STORAGE_ENV = {
    endpoint: ["S3_ENDPOINT", "S3_ENDPOINT_URL", "R2_ENDPOINT", "R2_ENDPOINT_URL"],
    region: ["S3_REGION", "R2_REGION", "AWS_REGION"],
    bucket: ["S3_BUCKET", "S3_MEDIA_BUCKET", "R2_BUCKET"],
    accessKeyId: ["S3_ACCESS_KEY", "S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
    secretAccessKey: ["S3_SECRET_KEY", "S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
    presignEndpoint: ["S3_PRESIGN_ENDPOINT", "S3_UPLOAD_PUBLIC_ENDPOINT"],
    publicBaseUrl: ["MEDIA_PUBLIC_BASE_URL", "S3_PUBLIC_URL", "S3_PUBLIC_BASE_URL", "R2_PUBLIC_URL", "R2_PUBLIC_BASE_URL"],
} as const;

export const DEFAULT_STORAGE_REGION = "auto";

export function firstEnv(keys: readonly string[]): string {
    for (const key of keys) {
        const value = process.env[key]?.trim();
        if (value) return value;
    }
    return "";
}

export type StorageSettings = {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Endpointul pentru URL-urile presemnate folosite de browser. */
    presignEndpoint: string;
};

/** Setările complete, sau null dacă lipsește ceva obligatoriu. */
export function readStorageSettings(): StorageSettings | null {
    const endpoint = firstEnv(STORAGE_ENV.endpoint);
    const bucket = firstEnv(STORAGE_ENV.bucket);
    const accessKeyId = firstEnv(STORAGE_ENV.accessKeyId);
    const secretAccessKey = firstEnv(STORAGE_ENV.secretAccessKey);
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    return {
        endpoint,
        region: firstEnv(STORAGE_ENV.region) || DEFAULT_STORAGE_REGION,
        bucket,
        accessKeyId,
        secretAccessKey,
        presignEndpoint: firstEnv(STORAGE_ENV.presignEndpoint) || endpoint,
    };
}

export function isStorageConfigured(): boolean {
    return readStorageSettings() !== null;
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

/**
 * Baza publică a obiectelor (fără `/` final). Fallback pentru dev fără CDN:
 * `<S3_ENDPOINT>/<bucket>` (path style, merge cu MinIO). "" dacă nu e nimic setat.
 */
export function mediaPublicBaseUrl(): string {
    const configured = firstEnv(STORAGE_ENV.publicBaseUrl);
    if (configured) return trimSlash(configured);
    const endpoint = firstEnv(STORAGE_ENV.endpoint);
    const bucket = firstEnv(STORAGE_ENV.bucket);
    return endpoint && bucket ? `${trimSlash(endpoint)}/${bucket}` : "";
}

/** URL-ul public (CDN) al unei chei. */
export function mediaPublicUrl(key: string): string {
    return `${mediaPublicBaseUrl()}/${key.replace(/^\/+/, "")}`;
}

/** Cheia obiectului pentru un URL public din bucket-ul nostru; null pentru orice alt host/cale. */
export function objectKeyFromMediaUrl(url: string): string | null {
    const base = mediaPublicBaseUrl();
    if (!base || !url.startsWith(`${base}/`)) return null;
    let key: string;
    try {
        key = decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0]);
    } catch {
        return null;
    }
    if (!key || key.split("/").includes("..")) return null;
    return key;
}

function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * Originile de media configurate, pentru CSP (`media-src`/`connect-src`): CDN-ul
 * public, originea URL-urilor semnate și endpointul S3 pe care browserul urcă
 * direct (upload presemnat). Doar https, fără duplicate, fără valori invalide.
 */
export function mediaCspOrigins(): string[] {
    const candidates = [
        mediaPublicBaseUrl(),
        firstEnv(["MEDIA_SIGNED_BASE_URL"]),
        firstEnv(STORAGE_ENV.presignEndpoint) || firstEnv(STORAGE_ENV.endpoint),
    ];
    const origins: string[] = [];
    for (const candidate of candidates) {
        const origin = candidate ? originOf(candidate) : null;
        if (origin && origin.startsWith("https://") && !origins.includes(origin)) origins.push(origin);
    }
    return origins;
}
