import { describe, expect, it } from "vitest";
import { EMPTY_DETAILS, extractHashtags, toVideoPatch } from "@/lib/upload/details";
import {
  PartUploadError,
  isFatalStatus,
  partRange,
  retryDelayMs,
  uploadMultipart,
  type MultipartDeps,
} from "@/lib/upload/multipart-client";
import { clampTrim, defaultTrim, trimForServer } from "@/lib/upload/trim";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import { VideoDetailsSchema } from "@/lib/video/upload/schemas";

function fakeDeps(over: Partial<MultipartDeps> = {}) {
  const puts: number[] = [];
  const signCalls: number[][] = [];
  const deps: MultipartDeps = {
    signParts: async (nums) => {
      signCalls.push(nums);
      return nums.map((n) => ({ partNumber: n, url: `https://s3/p${n}` }));
    },
    listParts: async () => [],
    putPart: async (url, body, _signal, onProgress) => {
      onProgress(body.size);
      puts.push(Number(url.split("/p")[1]));
    },
    sleep: async () => undefined,
    waitOnline: async () => undefined,
    random: () => 0.5,
    ...over,
  };
  return { deps, puts, signCalls };
}

const file = new Blob([new Uint8Array(25)]);

describe("uploadMultipart", () => {
  it("uploads every part with real byte progress ending at 100%", async () => {
    const { deps, puts } = fakeDeps();
    const progress: number[] = [];
    await uploadMultipart(
      { file, partSize: 10, totalParts: 3, signal: new AbortController().signal, onProgress: (l) => progress.push(l), concurrency: 1 },
      deps,
    );
    expect(puts.sort()).toEqual([1, 2, 3]);
    expect(progress.at(-1)).toBe(25);
  });

  it("resumes: parts already in S3 (right size) are skipped", async () => {
    const { deps, puts } = fakeDeps({ listParts: async () => [{ partNumber: 1, size: 10 }, { partNumber: 2, size: 3 }] });
    await uploadMultipart({ file, partSize: 10, totalParts: 3, signal: new AbortController().signal, onProgress: () => undefined }, deps);
    expect(puts.sort()).toEqual([2, 3]); // partea 2 incompletă se reurcă
  });

  it("retries transient failures and re-signs on 403 (expired URL)", async () => {
    let calls = 0;
    const { deps, signCalls } = fakeDeps({
      putPart: async (_url, body, _s, onProgress) => {
        calls += 1;
        if (calls === 1) throw new PartUploadError(403);
        if (calls === 2) throw new PartUploadError(0);
        onProgress(body.size);
      },
    });
    await uploadMultipart({ file, partSize: 30, totalParts: 1, signal: new AbortController().signal, onProgress: () => undefined }, deps);
    expect(calls).toBe(3);
    expect(signCalls.length).toBe(2);
  });

  it("stops on fatal statuses and after maxAttempts", async () => {
    const fatal = fakeDeps({ putPart: async () => Promise.reject(new PartUploadError(410)) });
    await expect(
      uploadMultipart({ file, partSize: 30, totalParts: 1, signal: new AbortController().signal, onProgress: () => undefined }, fatal.deps),
    ).rejects.toMatchObject({ status: 410 });

    let n = 0;
    const flaky = fakeDeps({ putPart: async () => ((n += 1), Promise.reject(new PartUploadError(500))) });
    await expect(
      uploadMultipart(
        { file, partSize: 30, totalParts: 1, signal: new AbortController().signal, onProgress: () => undefined, maxAttempts: 3 },
        flaky.deps,
      ),
    ).rejects.toBeInstanceOf(PartUploadError);
    expect(n).toBe(3);
  });

  it("cancel aborts before any part is sent", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { deps, puts } = fakeDeps();
    await expect(
      uploadMultipart({ file, partSize: 10, totalParts: 3, signal: ctl.signal, onProgress: () => undefined }, deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(puts).toEqual([]);
  });

  it("helpers: ranges, backoff, fatal statuses", () => {
    expect(partRange(3, 10, 25)).toEqual([20, 25]);
    expect(retryDelayMs(1, 1000, () => 0.5)).toBe(1000);
    expect(retryDelayMs(3, 1000, () => 0.5)).toBe(4000);
    expect(retryDelayMs(20, 1000, () => 0.5)).toBe(30_000);
    expect(isFatalStatus(409)).toBe(true);
    expect(isFatalStatus(503)).toBe(false);
  });
});

describe("trim", () => {
  it("defaults to the whole clip clamped to the max duration", () => {
    expect(defaultTrim(10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(defaultTrim(VIDEO_LIMITS.maxDurationMs * 2).endMs).toBe(VIDEO_LIMITS.maxDurationMs);
  });

  it("keeps the range within min/max while moving an edge", () => {
    const d = VIDEO_LIMITS.maxDurationMs * 2;
    const moved = clampTrim({ startMs: 0, endMs: d }, d, "end");
    expect(moved.endMs - moved.startMs).toBe(VIDEO_LIMITS.maxDurationMs);
    const tiny = clampTrim({ startMs: 5_000, endMs: 5_100 }, 20_000, "start");
    expect(tiny.endMs - tiny.startMs).toBe(VIDEO_LIMITS.minDurationMs);
  });

  it("sends null for edges that cut nothing", () => {
    expect(trimForServer({ startMs: 0, endMs: 8_000 }, 8_000)).toEqual({ startMs: null, endMs: null });
    expect(trimForServer({ startMs: 1_000, endMs: 5_000 }, 8_000)).toEqual({ startMs: 1_000, endMs: 5_000 });
    expect(trimForServer(null, null)).toEqual({ startMs: null, endMs: null });
  });
});

describe("details → PATCH body", () => {
  it("extracts unicode hashtags without duplicates", () => {
    expect(extractHashtags("Rochie #vară #Vară #ofertă_zilei text#nu")).toEqual(["vară", "ofertă_zilei", "nu"]);
  });

  it("builds a body accepted by the server schema for every intent", () => {
    const details = { ...EMPTY_DETAILS, title: " Titlu ", description: "Salut #test", productId: "p1", productOverlaySec: 2.5 };
    const pub = toVideoPatch(details, "public");
    expect(pub).toMatchObject({ title: "Titlu", tags: ["test"], product_overlay_ms: 2500, publish: "public" });
    expect(VideoDetailsSchema.safeParse(pub).success).toBe(true);
    const sched = toVideoPatch(details, "scheduled", "2030-01-01T10:00:00.000Z");
    expect(VideoDetailsSchema.safeParse(sched).success).toBe(true);
    expect(sched.scheduled_publish_at).toBe("2030-01-01T10:00:00.000Z");
    expect(toVideoPatch(EMPTY_DETAILS, "draft").title).toBeUndefined();
  });

  it("trimite missionId doar când alegerea diferă de ce e legat pe server", () => {
    const MID = "11111111-2222-4333-8444-555555555555";
    const picked = { ...EMPTY_DETAILS, missionId: MID };
    const body = toVideoPatch(picked, "public");
    expect(body.missionId).toBe(MID);
    expect(VideoDetailsSchema.safeParse(body).success).toBe(true);
    expect("missionId" in toVideoPatch(picked, "draft", undefined, MID)).toBe(false);
    expect("missionId" in toVideoPatch(EMPTY_DETAILS, "draft")).toBe(false);
    expect(toVideoPatch(EMPTY_DETAILS, "public", undefined, MID).missionId).toBeNull();
  });
});
