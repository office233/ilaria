/**
 * Importul unui episod PLĂTIT direct în prefixul privat: același pipeline ca
 * `enqueueVideoPipeline` (videos → upload session → asset → job → coada Redis),
 * dar jobul primește un `output_prefix` privat ALEATOR, deci worker-ul scrie
 * HLS-ul episodului direct în `private/movies/<rnd>/` — nu există niciun moment
 * în care episodul plătit să fie în prefixul public.
 *
 * Thumbnail-ul generat de worker ajunge tot în directorul privat; DTO-urile nu
 * îl expun (vezi `publicEpisodeThumbnail`), iar `ensureEpisodeMediaPrivate`
 * îl copiază la o cheie publică aleatoare când titlul se modifică/publică.
 *
 * TODO(feed-video): o opțiune `outputPrefix` în `enqueueVideoPipeline` ar
 * elimina duplicarea insert-urilor de mai jos.
 */
import { randomUUID } from "node:crypto";
import { withTransaction } from "@/lib/db";
import { getVideoStorageBucket, VIDEO_PATHS } from "@/lib/storage/video-storage";
import { publishProcessVideoJob } from "@/lib/video/redis-queue";
import { buildProcessVideoJobPayload, storageProviderFromEnv } from "@/lib/video/upload-session";
import { newPrivateMediaDir } from "@/lib/media/private-media";
import { MOVIES_MEDIA_VERTICAL } from "./private-media";

const SESSION_TTL_MS = 60 * 60 * 1000;
const TITLE_MAX = 280;

export type PrivateIngestInput = { sourceUrl: string; title: string; creatorId: string; metadata: Record<string, unknown> };

/** Payload-ul jobului cu toate cheile de ieșire în directorul privat. Pur (testabil). */
export function privateJobPayload(base: ReturnType<typeof buildProcessVideoJobPayload>, privateDir: string) {
    const prefix = privateDir.replace(/\/+$/, "");
    return {
        ...base,
        output_prefix: prefix,
        thumbnail_key: `${prefix}/thumbnail.jpg`,
        preview_key: `${prefix}/preview.mp4`,
        hls_master_key: `${prefix}/master.m3u8`,
    };
}

export async function enqueuePrivateEpisodeTranscode(input: PrivateIngestInput): Promise<{ videoId: string; queued: boolean }> {
    if (!/^https:\/\//i.test(input.sourceUrl)) throw new Error("sourceUrl must be https");
    const storageProvider = storageProviderFromEnv();
    const bucket = getVideoStorageBucket();
    const videoId = randomUUID();
    const sessionId = randomUUID();
    const assetId = randomUUID();
    const jobId = randomUUID();
    const rawObjectKey = `${VIDEO_PATHS.raw}/${videoId}.mp4`;
    const title = input.title.slice(0, TITLE_MAX);
    const metadata = {
        ...input.metadata,
        source: "external_import",
        source_url: input.sourceUrl,
        raw_object_key: rawObjectKey,
        upload_session_id: sessionId,
        source_asset_id: assetId,
        process_video_job_id: jobId,
        media_private: true,
    };
    const payload = privateJobPayload(
        buildProcessVideoJobPayload({
            jobId, uploadId: sessionId, videoId, assetId, creatorId: input.creatorId, bucket,
            sourceKey: rawObjectKey, sourceUrl: input.sourceUrl, contentType: "video/mp4", byteSize: 0, metadata,
        }),
        newPrivateMediaDir(MOVIES_MEDIA_VERTICAL),
    );

    await withTransaction(async (q) => {
        await q(
            `INSERT INTO videos (id, creator_id, title, description, visibility, status, product_refs, tags, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, '', 'draft', 'processing', '[]'::jsonb, $4::text[], $5::jsonb, NOW(), NOW())`,
            [videoId, input.creatorId, title, [MOVIES_MEDIA_VERTICAL], JSON.stringify(metadata)],
        );
        await q(
            `INSERT INTO video_upload_sessions (id, user_id, video_id, storage_provider, bucket, object_key, upload_id,
                                                status, byte_size, content_type, source_url, expires_at, metadata, created_at, updated_at)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $1::text, 'completed', 0, 'video/mp4', $7, $8, $9::jsonb, NOW(), NOW())`,
            [sessionId, input.creatorId, videoId, storageProvider, bucket, rawObjectKey, input.sourceUrl,
             new Date(Date.now() + SESSION_TTL_MS).toISOString(), JSON.stringify(metadata)],
        );
        await q(
            `INSERT INTO video_assets (id, video_id, asset_type, storage_provider, bucket, object_key, mime_type, byte_size, status, metadata, created_at, updated_at)
             VALUES ($1, $2, 'source', $3, $4, $5, 'video/mp4', 0, 'uploading', $6::jsonb, NOW(), NOW())`,
            [assetId, videoId, storageProvider, bucket, rawObjectKey, JSON.stringify(metadata)],
        );
        await q(
            `INSERT INTO video_processing_jobs (id, video_id, asset_id, job_type, status, priority, attempt_count, max_attempts,
                                                scheduled_at, source_url, payload, created_at, updated_at)
             VALUES ($1, $2, $3, 'transcode', 'queued', 100, 0, 3, NOW(), $4, $5::jsonb, NOW(), NOW())`,
            [jobId, videoId, assetId, input.sourceUrl, JSON.stringify(payload)],
        );
    });
    const queue = await publishProcessVideoJob(payload);
    return { videoId, queued: queue.queued };
}
