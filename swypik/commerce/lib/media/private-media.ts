/**
 * Media plătită în prefixul PRIVAT al bucket-ului (`MEDIA_PRIVATE_PREFIX`,
 * implicit `private/`): Worker-ul CDN răspunde 403 la acces direct, iar
 * redarea merge doar prin URL-uri semnate (`signed-media.ts`).
 *
 * Directorul privat al unui titlu e ALEATOR (128 biți), nu derivat din id-ul
 * videoului: nimic public (id, thumbnail, poster) nu permite ghicirea căii.
 * Thumbnail-ul se copiază separat, la o cheie publică aleatoare fără legătură
 * cu directorul HLS.
 */
import { randomBytes } from "node:crypto";
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getS3Client, getStorageBucket } from "@/lib/storage/s3-client";
import { objectKeyFromMediaUrl } from "@/lib/storage/config";
import { mediaPrivatePrefix } from "./stream-proxy";

/** Unde scrie pipeline-ul video clipurile publice (`videos/hls/<id>/`, lângă `master.m3u8`). */
export const PUBLIC_HLS_PREFIX = "videos/hls/";
const RANDOM_BYTES = 16;
const DELETE_BATCH = 1000;

function randomSegment(): string {
    return randomBytes(RANDOM_BYTES).toString("hex");
}

/** `private/<vertical>/<aleator>/` — directorul nou pentru media plătită. */
export function newPrivateMediaDir(vertical: string): string {
    return `${mediaPrivatePrefix()}${vertical}/${randomSegment()}/`;
}

/** `<vertical>/thumbs/<aleator>.jpg` — thumbnail public, fără legătură cu directorul HLS. */
export function newPublicThumbKey(vertical: string): string {
    return `${vertical}/thumbs/${randomSegment()}.jpg`;
}

export function isPrivateKey(key: string | null): boolean {
    return key !== null && key.startsWith(mediaPrivatePrefix());
}

/** Cheia unui URL din bucket-ul nostru (null pentru URL-uri externe / lipsă). */
export function keyOf(url: string | null | undefined): string | null {
    return url ? objectKeyFromMediaUrl(url) : null;
}

/** Directorul unei chei (`a/b/master.m3u8` → `a/b/`). */
export function dirOf(key: string): string {
    return key.slice(0, key.lastIndexOf("/") + 1);
}

export async function listKeys(prefix: string): Promise<string[]> {
    const s3 = getS3Client();
    const keys: string[] = [];
    let token: string | undefined;
    do {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: getStorageBucket(), Prefix: prefix, ContinuationToken: token }));
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

export async function copyKey(from: string, to: string): Promise<void> {
    const bucket = getStorageBucket();
    await getS3Client().send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${encodeURI(from)}`, Key: to }));
}

/** Copiază tot conținutul lui `fromDir` în `toDir` (aceleași căi relative). Întoarce cheile sursă. */
export async function copyDirectory(fromDir: string, toDir: string): Promise<string[]> {
    const keys = await listKeys(fromDir);
    for (const k of keys) await copyKey(k, `${toDir}${k.slice(fromDir.length)}`);
    return keys;
}

export async function deleteKeys(keys: string[]): Promise<void> {
    const s3 = getS3Client();
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        await s3.send(new DeleteObjectsCommand({ Bucket: getStorageBucket(), Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    }
}
