import { describe, expect, it } from "vitest";
import {
  VIDEO_LIMITS,
  canonicalVideoType,
  checkVideoDuration,
  checkVideoFile,
  isAcceptedVideoType,
  partCountFor,
  workerLimits,
} from "@/lib/video/limits";
import { CreateUploadSessionSchema } from "@/lib/video/upload/schemas";
import { buildProcessVideoJobPayload } from "@/lib/video/upload-session";

const MB = 1024 * 1024;

describe("VIDEO_LIMITS — sursa unică a limitelor", () => {
  it("keeps multipart parts under the Cloudflare 100MB body cap and above the S3 5MB minimum", () => {
    expect(VIDEO_LIMITS.partSizeBytes).toBeGreaterThanOrEqual(5 * MB);
    expect(VIDEO_LIMITS.partSizeBytes).toBeLessThan(100 * MB);
    expect(partCountFor(VIDEO_LIMITS.maxBytes)).toBeLessThanOrEqual(VIDEO_LIMITS.maxParts);
  });

  it("the zod schema, the file check and the worker payload all use the same numbers", () => {
    const tooBig = CreateUploadSessionSchema.safeParse({ filename: "a.mp4", sizeBytes: VIDEO_LIMITS.maxBytes + 1 });
    expect(tooBig.success).toBe(false);
    expect(checkVideoFile({ name: "a.mp4", type: "video/mp4", size: VIDEO_LIMITS.maxBytes + 1 })).toBe("too_large");
    expect(checkVideoFile({ name: "a.mp4", type: "video/mp4", size: VIDEO_LIMITS.maxBytes })).toBeNull();

    const payload = buildProcessVideoJobPayload({
      jobId: "j", uploadId: "u", videoId: "v", assetId: "a", creatorId: "c", bucket: "b", sourceKey: "k",
    });
    expect(payload.limits).toEqual(workerLimits());
    expect(payload.limits.max_duration_ms).toBe(VIDEO_LIMITS.maxDurationMs);
  });

  it("accepts real video types and extension-only uploads, rejects images", () => {
    expect(isAcceptedVideoType("video/quicktime", "IMG_1.MOV")).toBe(true);
    expect(isAcceptedVideoType("", "clip.webm")).toBe(true);
    expect(isAcceptedVideoType("application/octet-stream", "clip.m4v")).toBe(true);
    expect(isAcceptedVideoType("image/png", "still.png")).toBe(false);
    expect(isAcceptedVideoType("video/x-msvideo", "old.avi")).toBe(false);
    expect(checkVideoFile({ name: "x.mp4", type: "video/mp4", size: 0 })).toBe("empty");
  });

  it("derives a canonical MIME type from the extension", () => {
    expect(canonicalVideoType("", "a.mov")).toBe("video/quicktime");
    expect(canonicalVideoType("video/webm;codecs=vp9", "a.webm")).toBe("video/webm");
    expect(canonicalVideoType("", "a.mp4")).toBe("video/mp4");
  });

  it("checks durations with tolerance", () => {
    expect(checkVideoDuration(500)).toBe("too_short");
    expect(checkVideoDuration(VIDEO_LIMITS.maxDurationMs + VIDEO_LIMITS.durationToleranceMs)).toBeNull();
    expect(checkVideoDuration(VIDEO_LIMITS.maxDurationMs + VIDEO_LIMITS.durationToleranceMs + 1)).toBe("too_long");
    expect(checkVideoDuration(Number.NaN)).toBe("too_short");
  });
});
