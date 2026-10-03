/**
 * Clienții S3 (singleton per proces, fără stare pe disc — replicile web sunt
 * identice și stateless). Aceeași configurație pentru MinIO și R2:
 *   - path style (MinIO nu suportă virtual host; R2/S3 acceptă ambele);
 *   - checksum-uri doar când operația le cere: SDK-ul v3 recent adaugă implicit
 *     CRC32 și în URL-urile presemnate, pe care browserul nu le poate respecta.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { readStorageSettings, type StorageSettings } from "./config";

let internalClient: S3Client | null = null;
let presignClient: S3Client | null = null;

function build(settings: StorageSettings, endpoint: string): S3Client {
    return new S3Client({
        region: settings.region,
        endpoint,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
    });
}

function requireSettings(): StorageSettings {
    const settings = readStorageSettings();
    if (!settings) throw new Error("S3 storage is not configured. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY.");
    return settings;
}

/** Clientul pentru operațiile făcute de server (endpointul intern). */
export function getS3Client(): S3Client {
    if (!internalClient) {
        const settings = requireSettings();
        internalClient = build(settings, settings.endpoint);
    }
    return internalClient;
}

/**
 * Clientul pentru URL-uri presemnate folosite DIN BROWSER: semnătura SigV4
 * include host-ul, deci semnăm direct pe endpointul public (S3_PRESIGN_ENDPOINT).
 * Pe R2 endpointul S3 e deja public, deci coincide cu cel intern.
 */
export function getPresignClient(): S3Client {
    if (!presignClient) {
        const settings = requireSettings();
        if (settings.presignEndpoint === settings.endpoint) return getS3Client();
        presignClient = build(settings, settings.presignEndpoint);
    }
    return presignClient;
}

export function getStorageBucket(): string {
    return requireSettings().bucket;
}

/** Doar pentru teste: uită clienții (după schimbarea env-ului). */
export function resetS3ClientsForTests(): void {
    internalClient = null;
    presignClient = null;
}
