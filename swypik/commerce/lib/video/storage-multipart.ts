/**
 * Operațiile S3 multipart pentru uploadul video (MinIO/R2/S3).
 *
 * Operațiile de control (create/list/complete/abort/head) rulează pe clientul
 * intern; URL-urile de UploadPart sunt semnate pe endpointul public
 * (S3_UPLOAD_PUBLIC_ENDPOINT), pentru că browserul urcă direct părțile.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getPresignClient, getS3Client, getVideoStorageBucket } from "@/lib/storage/video-storage";
import { VIDEO_LIMITS } from "@/lib/video/limits";

export type UploadedPart = { partNumber: number; etag: string; size: number };

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const out = await getS3Client().send(
    new CreateMultipartUploadCommand({ Bucket: getVideoStorageBucket(), Key: key, ContentType: contentType }),
  );
  if (!out.UploadId) throw new Error("multipart_init_failed");
  return out.UploadId;
}

/** Mărimea exactă a părții `partNumber` (ultima poate fi mai mică) — aceeași regulă ca partRange din client. */
export function expectedPartSize(partNumber: number, partSize: number, byteSize: number): number | null {
  if (!(partSize > 0) || !(byteSize > 0)) return null;
  const start = (partNumber - 1) * partSize;
  const size = Math.min(partSize, byteSize - start);
  return size > 0 ? size : null;
}

/**
 * `sizing` (mărimea declarată la init + mărimea părții): URL-ul semnează și
 * `Content-Length` — un client nu mai poate urca părți mult peste 8 MB care
 * ocupă storage până la `complete`/curățare.
 */
export async function signUploadParts(
  key: string,
  uploadId: string,
  partNumbers: number[],
  sizing?: { partSize: number; byteSize: number },
): Promise<Array<{ partNumber: number; url: string }>> {
  const client = getPresignClient();
  const bucket = getVideoStorageBucket();
  return Promise.all(
    partNumbers.map(async (partNumber) => {
      const length = sizing ? expectedPartSize(partNumber, sizing.partSize, sizing.byteSize) : null;
      return {
        partNumber,
        url: await getSignedUrl(
          client,
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            ...(length ? { ContentLength: length } : {}),
          }),
          { expiresIn: VIDEO_LIMITS.partUrlTtlSec, ...(length ? { signableHeaders: new Set(["content-length"]) } : {}) },
        ),
      };
    }),
  );
}

export async function listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[]> {
  const client = getS3Client();
  const bucket = getVideoStorageBucket();
  const parts: UploadedPart[] = [];
  let marker: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const out = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
    );
    for (const p of out.Parts ?? []) {
      if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: Number(p.Size ?? 0) });
    }
    if (!out.IsTruncated || !out.NextPartNumberMarker) break;
    marker = String(out.NextPartNumberMarker);
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
  await getS3Client().send(
    new CompleteMultipartUploadCommand({
      Bucket: getVideoStorageBucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await getS3Client().send(
    new AbortMultipartUploadCommand({ Bucket: getVideoStorageBucket(), Key: key, UploadId: uploadId }),
  );
}

/** HEAD pe obiect: null dacă nu există. */
export async function headObject(key: string): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const out = await getS3Client().send(new HeadObjectCommand({ Bucket: getVideoStorageBucket(), Key: key }));
    return { size: Number(out.ContentLength ?? 0), contentType: out.ContentType ?? null };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw err;
  }
}

/** Urcare server-side a unui obiect mic (ex. coperta JPEG aleasă de creator). */
export async function putSmallObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getVideoStorageBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}
