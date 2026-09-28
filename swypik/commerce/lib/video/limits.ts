/**
 * Limitele uploadului video — O SINGURĂ sursă pentru client (wizard, cameră),
 * API (zod + validare sesiune) și worker (trimise în payload-ul jobului ca
 * `limits`, vezi buildProcessVideoJobPayload).
 *
 * Suprascriere la build (vizibilă și în browser): NEXT_PUBLIC_VIDEO_MAX_UPLOAD_MB,
 * NEXT_PUBLIC_VIDEO_MAX_DURATION_SEC, NEXT_PUBLIC_VIDEO_MAX_RECORD_SEC.
 */

const MB = 1024 * 1024;

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const VIDEO_LIMITS = Object.freeze({
  /** Dimensiunea maximă a fișierului sursă. */
  maxBytes: envInt(process.env.NEXT_PUBLIC_VIDEO_MAX_UPLOAD_MB, 500, 10, 4096) * MB,
  /** Durata minimă / maximă a clipului publicat (după trim). */
  minDurationMs: 1_000,
  maxDurationMs: envInt(process.env.NEXT_PUBLIC_VIDEO_MAX_DURATION_SEC, 180, 5, 1800) * 1000,
  /** Durata maximă a unei înregistrări din camera browserului. */
  maxRecordMs: envInt(process.env.NEXT_PUBLIC_VIDEO_MAX_RECORD_SEC, 60, 5, 600) * 1000,
  /** Toleranță la verificarea duratei (metadatele containerului rotunjesc). */
  durationToleranceMs: 500,
  acceptedMimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"] as readonly string[],
  acceptedExtensions: [".mp4", ".mov", ".webm", ".m4v"] as readonly string[],
  /**
   * Mărimea unei părți multipart. Sub limita Cloudflare de 100MB per request
   * și peste minimul S3 de 5MB (ultima parte poate fi mai mică).
   */
  partSizeBytes: 8 * MB,
  maxParts: 10_000,
  uploadConcurrency: 3,
  partMaxAttempts: 5,
  partRetryBaseMs: 1_000,
  /** Cât trăiește o sesiune de upload (reluare după pierderea conexiunii). */
  sessionTtlSec: 24 * 60 * 60,
  /** Valabilitatea unui URL presemnat pentru o parte. */
  partUrlTtlSec: 60 * 60,
  maxPartUrlsPerRequest: 50,
  titleMaxChars: 100,
  descriptionMaxChars: 2_200,
  hashtagsMax: 30,
  hashtagMaxChars: 64,
  coverMaxBytes: 2 * MB,
  captionTextMaxChars: 20_000,
  /** Polling-ul statusului de procesare (cu backoff până la max). */
  statusPollMinMs: 2_000,
  statusPollMaxMs: 10_000,
});

export type VideoFileProblem = "empty" | "too_large" | "unsupported_type";
export type VideoDurationProblem = "too_short" | "too_long";

export function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function isAcceptedVideoType(contentType: string, filename: string): boolean {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (VIDEO_LIMITS.acceptedMimeTypes.includes(type)) return true;
  // Unele browsere (Android vechi, Windows) trimit tip gol sau generic.
  const generic = type === "" || type === "application/octet-stream" || type.startsWith("video/");
  return generic && VIDEO_LIMITS.acceptedExtensions.includes(fileExtension(filename));
}

/** Tipul MIME canonic pentru stocare (derivat din extensie când browserul nu îl dă). */
export function canonicalVideoType(contentType: string, filename: string): string {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (VIDEO_LIMITS.acceptedMimeTypes.includes(type)) return type;
  switch (fileExtension(filename)) {
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".m4v":
      return "video/x-m4v";
    default:
      return "video/mp4";
  }
}

export function checkVideoFile(file: { name: string; type: string; size: number }): VideoFileProblem | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty";
  if (file.size > VIDEO_LIMITS.maxBytes) return "too_large";
  if (!isAcceptedVideoType(file.type, file.name)) return "unsupported_type";
  return null;
}

export function checkVideoDuration(durationMs: number): VideoDurationProblem | null {
  if (!Number.isFinite(durationMs) || durationMs < VIDEO_LIMITS.minDurationMs) return "too_short";
  if (durationMs > VIDEO_LIMITS.maxDurationMs + VIDEO_LIMITS.durationToleranceMs) return "too_long";
  return null;
}

export function partCountFor(sizeBytes: number, partSize = VIDEO_LIMITS.partSizeBytes): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

export function maxUploadMb(): number {
  return Math.round(VIDEO_LIMITS.maxBytes / MB);
}

export function maxDurationSec(): number {
  return Math.round(VIDEO_LIMITS.maxDurationMs / 1000);
}

/** Subsetul trimis workerului în payload-ul jobului. */
export function workerLimits(): { min_duration_ms: number; max_duration_ms: number } {
  return { min_duration_ms: VIDEO_LIMITS.minDurationMs, max_duration_ms: VIDEO_LIMITS.maxDurationMs };
}
