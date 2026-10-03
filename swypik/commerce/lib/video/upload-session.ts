import {
  VIDEO_LIMITS,
  canonicalVideoType,
  checkVideoFile,
  workerLimits,
} from "@/lib/video/limits";

const HASHTAG_PATTERN = /(^|\s)#([a-zA-Z0-9_-]+)/g;

export class UploadInputError extends Error {
  status = 400;
  code: string;
  constructor(message: string, code = "validation_error", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type CreatorUploadInput = {
  creatorId: string;
  productId: string;
  title: string;
  description: string;
  caption: string;
  challengeId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source: string;
  hashtags: string[];
  productRefs: Array<{ product_id: string; source: "creator_upload" }>;
  metadata: Record<string, unknown>;
  audioTrackId: number | null;
};

export type ProcessVideoJobPayload = {
  job_type: "process_video";
  type: "process_video";
  job_id: string;
  video_id: string;
  asset_id: string;
  upload_id: string;
  creator_id: string;
  product_id: string;
  storage_provider: string;
  bucket: string;
  source_bucket: string;
  output_bucket: string;
  object_key: string;
  source_key: string;
  output_prefix: string;
  thumbnail_key: string;
  preview_key: string;
  hls_master_key: string;
  /** Gol pentru uploadurile directe: workerul citește sursa din bucket (fără ocol prin CDN). */
  source_url: string;
  content_type: string;
  byte_size: number;
  limits: { min_duration_ms: number; max_duration_ms: number };
  trim: { start_ms: number | null; end_ms: number | null };
  metadata: Record<string, unknown>;
};

type RawCreatorUploadInput = {
  creatorId?: unknown;
  productId?: unknown;
  title?: unknown;
  description?: unknown;
  caption?: unknown;
  challengeId?: unknown;
  filename?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
  source?: unknown;
  hashtags?: unknown;
  audioTrackId?: unknown;
};

type ProcessVideoJobInput = {
  jobId: string;
  uploadId: string;
  videoId: string;
  assetId: string;
  creatorId: string;
  productId?: string;
  bucket: string;
  sourceKey: string;
  sourceUrl?: string;
  contentType?: string;
  byteSize?: number;
  storageProvider?: string;
  outputBucket?: string;
  trimStartMs?: number | null;
  trimEndMs?: number | null;
  metadata?: Record<string, unknown>;
};

export function normalizeCreatorUploadInput(raw: RawCreatorUploadInput): CreatorUploadInput {
  const creatorId = asString(raw.creatorId);
  const filename = sanitizeFilename(asString(raw.filename));
  const rawType = asString(raw.contentType);
  const sizeBytes = Number(raw.sizeBytes);

  if (!creatorId) throw new UploadInputError("creatorId is required");
  if (!filename) throw new UploadInputError("filename is required");

  const problem = checkVideoFile({ name: filename, type: rawType, size: sizeBytes });
  if (problem === "empty") throw new UploadInputError("sizeBytes must be positive", "file_empty");
  if (problem === "too_large") throw new UploadInputError("file exceeds the upload limit", "file_too_large", 413);
  if (problem === "unsupported_type") {
    throw new UploadInputError("contentType must be a video type", "unsupported_type", 415);
  }

  const title = asString(raw.title).slice(0, VIDEO_LIMITS.titleMaxChars);
  const description = asString(raw.description).slice(0, VIDEO_LIMITS.descriptionMaxChars);
  const caption = asString(raw.caption || raw.description).slice(0, VIDEO_LIMITS.descriptionMaxChars);
  const challengeId = asString(raw.challengeId);
  const productId = asString(raw.productId);
  const source = asString(raw.source) || "gallery";
  const hashtags = normalizeHashtags([
    extractPrefixedHashtags(caption),
    extractPrefixedHashtags(description),
    raw.hashtags,
  ]).slice(0, VIDEO_LIMITS.hashtagsMax);
  const productRefs = productId ? [{ product_id: productId, source: "creator_upload" as const }] : [];

  const audioTrackIdRaw = Number(raw.audioTrackId);
  const audioTrackId = Number.isFinite(audioTrackIdRaw) && audioTrackIdRaw > 0 ? Math.floor(audioTrackIdRaw) : null;

  return {
    creatorId,
    productId,
    title,
    description,
    caption,
    challengeId,
    filename,
    contentType: canonicalVideoType(rawType, filename),
    sizeBytes,
    source,
    hashtags,
    productRefs,
    metadata: {
      title,
      description,
      caption,
      hashtags,
      challenge_id: challengeId || null,
      product_id: productId || null,
      source,
      audio_track_id: audioTrackId,
    },
    audioTrackId,
  };
}

/** Furnizorul de stocare înregistrat în DB (prod rulează MinIO, nu R2). */
export function storageProviderFromEnv(): "r2" | "s3" | "minio" | "local" {
  const raw = (process.env.VIDEO_STORAGE_PROVIDER || "").trim().toLowerCase();
  if (raw === "s3" || raw === "minio" || raw === "local" || raw === "r2") return raw;
  return "r2";
}

export function buildProcessVideoJobPayload(input: ProcessVideoJobInput): ProcessVideoJobPayload {
  const storageProvider = input.storageProvider || storageProviderFromEnv();
  const outputBucket = input.outputBucket || input.bucket;
  const sourceKey = input.sourceKey.replace(/^\/+/, "");
  const hlsPrefix = `videos/hls/${input.videoId}`;

  return {
    job_type: "process_video",
    type: "process_video",
    job_id: input.jobId,
    video_id: input.videoId,
    asset_id: input.assetId,
    upload_id: input.uploadId,
    creator_id: input.creatorId,
    product_id: input.productId || "",
    storage_provider: storageProvider,
    bucket: input.bucket,
    source_bucket: input.bucket,
    output_bucket: outputBucket,
    object_key: sourceKey,
    source_key: sourceKey,
    output_prefix: hlsPrefix,
    thumbnail_key: `${hlsPrefix}/thumbnail.jpg`,
    preview_key: `${hlsPrefix}/preview.mp4`,
    hls_master_key: `${hlsPrefix}/master.m3u8`,
    source_url: input.sourceUrl || "",
    content_type: input.contentType || "video/mp4",
    byte_size: input.byteSize || 0,
    limits: workerLimits(),
    trim: { start_ms: input.trimStartMs ?? null, end_ms: input.trimEndMs ?? null },
    metadata: input.metadata || {},
  };
}

export function normalizeHashtags(values: unknown[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    for (const item of flattenHashtagValue(value)) {
      for (const tag of extractHashtags(item)) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    }
  }
  return tags;
}

export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    // eslint-disable-next-line no-control-regex
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned || "video.mp4";
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function extractHashtags(value: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  HASHTAG_PATTERN.lastIndex = 0;
  while ((match = HASHTAG_PATTERN.exec(value))) {
    const tag = normalizeHashtag(match[2]);
    if (tag) found.push(tag);
  }
  for (const part of value.split(/[\s,]+/)) {
    const tag = normalizeHashtag(part);
    if (tag) found.push(tag);
  }
  return found;
}

function extractPrefixedHashtags(value: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  HASHTAG_PATTERN.lastIndex = 0;
  while ((match = HASHTAG_PATTERN.exec(value))) found.push(match[2]);
  return found;
}

function normalizeHashtag(value: string): string {
  return value
    .replace(/^#+/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, VIDEO_LIMITS.hashtagMaxChars);
}

function flattenHashtagValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenHashtagValue);
  if (value === null || value === undefined) return [];
  return [String(value)];
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
