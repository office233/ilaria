/**
 * Upload server-side de imagini mici (avatar, poze produs, dovezi) în storage-ul
 * S3-compatibil (MinIO local, R2 în producție). Configurația: `lib/storage/config.ts`.
 * Totul în memorie (Buffer) — nimic pe discul replicii web.
 */

import { PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { isStorageConfigured as storageConfigured, mediaPublicUrl } from "./config";
import { getS3Client, getStorageBucket } from "./s3-client";

/** Imaginile au nume unic (UUID) → imutabile, cache lung pe CDN și în browser. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
  };
  return map[mimeType] || ".bin";
}

function hasValidImageSignature(file: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff;
  }

  if (mimeType === "image/png") {
    return (
      file.length >= 8 &&
      file[0] === 0x89 &&
      file[1] === 0x50 &&
      file[2] === 0x4e &&
      file[3] === 0x47 &&
      file[4] === 0x0d &&
      file[5] === 0x0a &&
      file[6] === 0x1a &&
      file[7] === 0x0a
    );
  }

  if (mimeType === "image/gif") {
    const signature = file.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }

  if (mimeType === "image/webp") {
    return file.length >= 12 && file.subarray(0, 4).toString("ascii") === "RIFF" && file.subarray(8, 12).toString("ascii") === "WEBP";
  }

  if (mimeType === "image/avif") {
    return file.length >= 12 && file.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(file.subarray(8, 12).toString("ascii"));
  }

  return false;
}

export interface UploadResult {
  url: string;
  key: string;
  size: number;
}

/**
 * Upload a file buffer to S3/R2.
 * Returns the public URL on success.
 */
export interface UploadOptions {
  keyPrefix?: string;
}

export async function uploadFile(
  file: Buffer,
  originalName: string,
  mimeType: string,
  options: UploadOptions = {}
): Promise<UploadResult> {
  // Validate
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Tip de fișier nepermis: ${mimeType}. Permise: JPEG, PNG, WebP, AVIF, GIF.`);
  }

  if (file.length > MAX_FILE_SIZE) {
    throw new Error(`Fișierul depășește limita de ${MAX_FILE_SIZE / (1024 * 1024)}MB.`);
  }

  if (file.length === 0) {
    throw new Error("Fișierul este gol.");
  }

  if (!hasValidImageSignature(file, mimeType)) {
    throw new Error("Fișierul nu corespunde tipului de imagine declarat.");
  }

  const client = getS3Client();
  const bucket = getStorageBucket();

  // Generate unique filename. Default prefix: products/YYYY/MM. Override via options.keyPrefix.
  const now = new Date();
  const defaultPrefix = `products/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = (options.keyPrefix || defaultPrefix).replace(/^\/+|\/+$/g, "");
  const uniqueId = crypto.randomUUID();
  const ext = getExtension(mimeType);
  const key = `${prefix}/${uniqueId}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file,
      ContentType: mimeType,
      CacheControl: IMMUTABLE_CACHE_CONTROL,
    })
  );

  return { url: mediaPublicUrl(key), key, size: file.length };
}

/**
 * Check if storage is configured (useful for UI to show/hide upload buttons).
 */
export function isStorageConfigured(): boolean {
  return storageConfigured();
}
