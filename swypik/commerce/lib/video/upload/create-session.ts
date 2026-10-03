/**
 * POST /api/creator/upload-session — pornește un upload multipart.
 * Creează clipul (draft, status 'uploading', moderare 'pending_review'),
 * sesiunea (cu UploadId-ul S3) și asset-ul sursă, într-o tranzacție.
 * Moderarea textului se face la publicare, pe textul final (nu pe numele fișierului).
 */
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { buildRawVideoObjectKey, getVideoStorageBucket } from "@/lib/storage/video-storage";
import { VIDEO_LIMITS, partCountFor } from "@/lib/video/limits";
import { abortMultipartUpload, createMultipartUpload } from "@/lib/video/storage-multipart";
import { storageProviderFromEnv, type CreatorUploadInput } from "@/lib/video/upload-session";
import { logger } from "@/lib/logger";

export type CreatedUploadSession = {
  sessionId: string;
  videoId: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
};

export function placeholderTitle(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  return (base || "video").slice(0, VIDEO_LIMITS.titleMaxChars);
}

export async function createUploadSession(input: CreatorUploadInput): Promise<CreatedUploadSession> {
  const sessionId = randomUUID();
  const videoId = randomUUID();
  const assetId = randomUUID();
  const bucket = getVideoStorageBucket();
  const provider = storageProviderFromEnv();
  const key = buildRawVideoObjectKey(sessionId, input.creatorId, input.filename);
  const partSize = VIDEO_LIMITS.partSizeBytes;
  const totalParts = partCountFor(input.sizeBytes, partSize);
  const expiresAt = new Date(Date.now() + VIDEO_LIMITS.sessionTtlSec * 1000);
  const multipartId = await createMultipartUpload(key, input.contentType);
  const title = input.title || placeholderTitle(input.filename);
  const metadata = { ...input.metadata, upload_session_id: sessionId, source_asset_id: assetId, source_object_key: key };

  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO videos (id, creator_id, title, description, visibility, status, is_draft,
                           moderation_status, product_refs, tags, metadata, audio_track_id,
                           created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', 'uploading', true, 'pending_review',
               $5::jsonb, $6::text[], $7::jsonb, $8, NOW(), NOW())`,
      [
        videoId,
        input.creatorId,
        title,
        input.description || input.caption || "",
        JSON.stringify(input.productRefs),
        input.hashtags,
        JSON.stringify(metadata),
        input.audioTrackId,
      ],
    );
    await client.query(
      `INSERT INTO video_upload_sessions (id, user_id, video_id, storage_provider, bucket, object_key,
                                          upload_id, status, byte_size, content_type, part_size,
                                          total_parts, expires_at, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading', $8, $9, $10, $11, $12, $13::jsonb, NOW(), NOW())`,
      [
        sessionId,
        input.creatorId,
        videoId,
        provider,
        bucket,
        key,
        multipartId,
        input.sizeBytes,
        input.contentType,
        partSize,
        totalParts,
        expiresAt.toISOString(),
        JSON.stringify(metadata),
      ],
    );
    await client.query(
      `INSERT INTO video_assets (id, video_id, asset_type, storage_provider, bucket, object_key,
                                 mime_type, byte_size, status, metadata, created_at, updated_at)
       VALUES ($1, $2, 'source', $3, $4, $5, $6, $7, 'uploading', $8::jsonb, NOW(), NOW())`,
      [assetId, videoId, provider, bucket, key, input.contentType, input.sizeBytes, JSON.stringify(metadata)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await abortMultipartUpload(key, multipartId).catch((err) =>
      logger.warn({ err, sessionId }, "[upload] abort after failed session insert"),
    );
    throw error;
  } finally {
    client.release();
  }

  return { sessionId, videoId, partSize, totalParts, expiresAt: expiresAt.toISOString() };
}
