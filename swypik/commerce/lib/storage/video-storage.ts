/**
 * Video Storage Service — URL-uri presemnate de upload și URL-uri publice CDN
 * pentru obiectele de media. Configurația vine din `lib/storage/config.ts`
 * (MinIO local, R2 în producție); clienții din `lib/storage/s3-client.ts`.
 */

import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sanitizeFilename } from "@/lib/video/upload-session";
import { isStorageConfigured, mediaPublicUrl, objectKeyFromMediaUrl } from "./config";
import { getPresignClient, getS3Client, getStorageBucket } from "./s3-client";

export { getPresignClient, getS3Client } from "./s3-client";

// ─── Video path prefixes ────────────────────────────────────────────────────

export const VIDEO_PATHS = {
  raw: "videos/raw",
  processed: "videos/processed",
  thumbnails: "videos/thumbnails",
  hls: "videos/hls",
} as const;

export function getVideoStorageBucket(): string {
  return getStorageBucket();
}

export function isVideoStorageConfigured(): boolean {
  return isStorageConfigured();
}

// ─── Presigned upload URL ───────────────────────────────────────────────────

const UPLOAD_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * Generate a presigned PUT URL for an arbitrary object key. Shared by video
 * and music uploads — same bucket, same presign client, same expiry.
 * The browser uploads directly to storage (no bytes through the app server).
 */
export async function createPresignedPutUrl(
  key: string,
  contentType: string
): Promise<{ url: string; key: string; expiresIn: number }> {
  const command = new PutObjectCommand({
    Bucket: getStorageBucket(),
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(getPresignClient(), command, { expiresIn: UPLOAD_EXPIRY_SECONDS });
  return { url, key, expiresIn: UPLOAD_EXPIRY_SECONDS };
}

/** Generate a presigned PUT URL for uploading a raw video file. */
export async function createVideoUploadUrl(
  upload: string | {
    uploadId: string;
    creatorId?: string;
    filename?: string;
    contentType?: string;
  }
): Promise<{ url: string; key: string; expiresIn: number }> {
  const key = typeof upload === "string"
    ? `${VIDEO_PATHS.raw}/${upload}.mp4`
    : buildRawVideoObjectKey(upload.uploadId, upload.creatorId, upload.filename);
  const contentType = typeof upload === "string" ? "video/mp4" : upload.contentType || "video/mp4";

  return createPresignedPutUrl(key, contentType);
}

export function buildRawVideoObjectKey(uploadId: string, creatorId?: string, filename?: string): string {
  const safeCreator = sanitizePathPart(creatorId || "creator");
  const safeUpload = sanitizePathPart(uploadId);
  const safeFilename = sanitizeFilename(filename || `${uploadId}.mp4`).replace(/\s+/g, "-");
  return `${VIDEO_PATHS.raw}/${safeCreator}/${safeUpload}/${safeFilename}`;
}

// ─── Presigned server-side GET (doar proxy-ul de dezvoltare) ────────────────

/**
 * URL GET presemnat, cu durată scurtă, pe clientul INTERN (endpointul văzut de
 * server, nu de browser). Îl folosește doar proxy-ul de stream din dezvoltare
 * (vezi `isServerMediaProxyAllowed`); în producție media privată merge prin
 * URL-uri semnate pe CDN (`lib/media/signed-media.ts`).
 */
export async function createPresignedGetUrl(key: string, expiresIn: number): Promise<string> {
  return getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: getStorageBucket(), Key: key }), { expiresIn });
}

/**
 * Inversul lui `getVideoAssetUrl`: cheia obiectului pentru un URL din bucket-ul
 * nostru, sau null pentru orice alt host/cale (ori storage neconfigurat).
 */
export function objectKeyFromAssetUrl(url: string): string | null {
  if (!isStorageConfigured()) return null;
  return objectKeyFromMediaUrl(url);
}

// ─── Public CDN URL ─────────────────────────────────────────────────────────

/** URL-ul public CDN (MEDIA_PUBLIC_BASE_URL) al unei chei. */
export function getVideoAssetUrl(key: string): string {
  return mediaPublicUrl(key);
}

export function sanitizePathPart(value: string): string {
  return sanitizeFilename(value)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}
