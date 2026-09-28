import { afterEach, describe, expect, it } from "vitest";
import {
  UploadInputError,
  buildProcessVideoJobPayload,
  normalizeCreatorUploadInput,
  storageProviderFromEnv,
} from "@/lib/video/upload-session";
import { derivePhase, toUploadStatus } from "@/lib/video/upload/status";
import type { UploadStatusRow } from "@/lib/video/upload/session-repo";

describe("normalizeCreatorUploadInput", () => {
  it("sanitizes the filename, merges hashtags and keeps the product ref", () => {
    const n = normalizeCreatorUploadInput({
      creatorId: "creator_1",
      productId: " product_1 ",
      title: " Demo clip ",
      caption: "Super oferta #Tech #tech #Casa-Mare",
      hashtags: " #manual, viral demo ",
      filename: "../camera final.MOV",
      contentType: "video/quicktime",
      sizeBytes: 42_000,
      source: "camera",
    });
    expect(n.filename).toBe("camera final.MOV");
    expect(n.contentType).toBe("video/quicktime");
    expect(n.title).toBe("Demo clip");
    expect(n.hashtags).toEqual(["tech", "casa-mare", "manual", "viral", "demo"]);
    expect(n.productRefs).toEqual([{ product_id: "product_1", source: "creator_upload" }]);
  });

  it("rejects non-video files with a stable code", () => {
    try {
      normalizeCreatorUploadInput({ creatorId: "c", filename: "still.png", contentType: "image/png", sizeBytes: 1 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UploadInputError);
      expect((err as UploadInputError).code).toBe("unsupported_type");
      expect((err as UploadInputError).status).toBe(415);
    }
  });
});

describe("buildProcessVideoJobPayload", () => {
  afterEach(() => {
    delete process.env.VIDEO_STORAGE_PROVIDER;
  });

  it("never sends a public source_url for direct uploads and carries trim + limits", () => {
    const p = buildProcessVideoJobPayload({
      jobId: "job_1",
      uploadId: "upload_1",
      videoId: "video_1",
      assetId: "asset_1",
      creatorId: "creator_1",
      bucket: "media",
      sourceKey: "/videos/raw/c/u/camera.mov",
      trimStartMs: 1500,
      trimEndMs: 9000,
    });
    expect(p.source_url).toBe("");
    expect(p.source_key).toBe("videos/raw/c/u/camera.mov");
    expect(p.output_prefix).toBe("videos/hls/video_1");
    expect(p.preview_key).toBe("videos/hls/video_1/preview.mp4");
    expect(p.trim).toEqual({ start_ms: 1500, end_ms: 9000 });
    expect(p.limits.min_duration_ms).toBeGreaterThan(0);
  });

  it("reads the storage provider from env (prod runs MinIO)", () => {
    expect(storageProviderFromEnv()).toBe("r2");
    process.env.VIDEO_STORAGE_PROVIDER = "minio";
    expect(storageProviderFromEnv()).toBe("minio");
    process.env.VIDEO_STORAGE_PROVIDER = "ftp";
    expect(storageProviderFromEnv()).toBe("r2");
  });
});

function row(over: Partial<UploadStatusRow>): UploadStatusRow {
  return {
    session_id: "s", upload_status: "completed", byte_size: "10", total_parts: 1, video_id: "v",
    video_status: "processing", visibility: "draft", moderation_status: "pending_review", title: "t",
    thumbnail_url: null, playback_url: null, duration_ms: null, width: null, height: null, job_id: "j",
    job_status: "running", job_stage: "transcoding", job_progress: 40, job_error_code: null,
    attempt_count: 1, max_attempts: 3, created_at: "2026-09-26T00:00:00Z", ...over,
  };
}

describe("upload status (real, no fake progress)", () => {
  it("derives the phase from session + video + job", () => {
    expect(derivePhase(row({ upload_status: "uploading", job_status: null }))).toBe("uploading");
    expect(derivePhase(row({ job_status: "queued" }))).toBe("queued");
    expect(derivePhase(row({}))).toBe("processing");
    expect(derivePhase(row({ video_status: "ready" }))).toBe("ready");
    expect(derivePhase(row({ video_status: "failed", job_status: "failed" }))).toBe("failed");
    expect(derivePhase(row({ upload_status: "aborted" }))).toBe("aborted");
  });

  it("exposes the worker's stage/progress and only offers retry for recoverable errors", () => {
    const s = toUploadStatus(row({}));
    expect(s.stage).toBe("transcoding");
    expect(s.progress).toBe(40);
    const noProgress = toUploadStatus(row({ job_progress: null }));
    expect(noProgress.progress).toBeNull();

    const transient = toUploadStatus(row({ video_status: "failed", job_status: "failed", job_error_code: "storage_error" }));
    expect(transient.canRetry).toBe(true);
    const tooLong = toUploadStatus(row({ video_status: "failed", job_status: "failed", job_error_code: "duration_too_long" }));
    expect(tooLong.canRetry).toBe(false);
    expect(tooLong.errorCode).toBe("duration_too_long");
  });
});
