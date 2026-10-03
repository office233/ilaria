import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedVideo: vi.fn() }));
vi.mock("@/lib/social/session", () => ({ getOptionalSocialUserId: async () => "u1" }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true }) }));
const notify = vi.hoisted(() => ({ notifyFollowersNewPost: vi.fn(async () => 1) }));
vi.mock("@/lib/notifications/dispatch", () => notify);
const s3 = vi.hoisted(() => ({
  headObject: vi.fn(async (): Promise<{ size: number; contentType: string } | null> => ({ size: 10, contentType: "video/mp4" })),
}));
vi.mock("@/lib/video/storage-multipart", () => s3);
const queue = vi.hoisted(() => ({ publishProcessVideoJob: vi.fn(async () => ({ queued: true, backend: "native" })) }));
vi.mock("@/lib/video/redis-queue", () => queue);

type Q = { sql: string; params: unknown[] };
let calls: Q[] = [];
let respond: (sql: string) => { rows: unknown[] } = () => ({ rows: [] });
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params });
  return respond(sql);
});
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => query(sql, params),
  getDb: () => ({ connect: async () => ({ query: (sql: string, params?: unknown[]) => query(sql, params), release: () => undefined }) }),
  withTransaction: async (fn: (q: typeof query) => Promise<unknown>) => fn(query),
}));

import { normalizeSegments, segmentsToVtt } from "@/lib/video/captions";
import { GET as publicCaptions } from "@/app/api/videos/[id]/captions/route";
import { reprocessVideo } from "@/lib/video/upload/reprocess";
import { POST as publishScheduled } from "@/app/api/cron/publish-scheduled/route";
import { linkVideoToMission } from "@/lib/missions/submissions";

const VID = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

beforeEach(() => {
  calls = [];
  respond = () => ({ rows: [] });
  notify.notifyFollowersNewPost.mockClear();
  queue.publishProcessVideoJob.mockClear();
});

describe("captions", () => {
  it("renders valid WebVTT (sorted, no empty/inverted cues, no cue-arrow injection)", () => {
    const vtt = segmentsToVtt([
      { start: 3.5, end: 5, text: "doi --> trei" },
      { start: 0, end: 1.25, text: " unu " },
      { start: 6, end: 6, text: "gol" },
      { start: 7, end: 8, text: "   " },
    ]);
    expect(vtt).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.250\nunu\n\n2\n00:00:03.500 --> 00:00:05.000\ndoi → trei\n");
    expect(segmentsToVtt([])).toBe("WEBVTT\n\n");
  });

  it("normalizes edited segments", () => {
    expect(normalizeSegments([{ start: 2, end: 3, text: " b  c " }, { start: -1, end: 1, text: "a" }])).toEqual([
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "b c" },
    ]);
  });

  it("public GET serves text/vtt only for visible videos", async () => {
    respond = () => ({ rows: [{ lang: "ro", text: "x", segments: [{ start: 0, end: 1, text: "x" }], is_auto: true }] });
    const res = await publicCaptions(new Request(`http://l/api/videos/${VID}/captions?lang=ro&format=vtt`), {
      params: Promise.resolve({ id: VID }),
    });
    expect(res.headers.get("content-type")).toContain("text/vtt");
    expect(await res.text()).toContain("00:00:00.000 --> 00:00:01.000");
    expect(calls[0].sql).toContain("v.effective_label = 'safe'");
    const bad = await publicCaptions(new Request(`http://l/x?lang=ro`), { params: Promise.resolve({ id: "nope" }) });
    expect(bad.status).toBe(400);
  });
});

describe("reprocessVideo (retry after a failed processing)", () => {
  const src = {
    session_id: "s", user_id: "u", bucket: "media", object_key: "videos/raw/k.mp4", content_type: "video/mp4", byte_size: "10",
    trim_start_ms: 500, trim_end_ms: null, asset_id: "a", status: "failed", product_refs: [], metadata: {}, last_error_code: "storage_error",
  };

  it("re-queues the stored source with the original trim and un-hides the draft", async () => {
    respond = (sql) => {
      if (sql.includes("FROM videos v")) return { rows: [src] };
      if (sql.includes("INSERT INTO video_processing_jobs")) return { rows: [{ id: "j" }] };
      return { rows: [] };
    };
    await reprocessVideo(VID);
    const payload = JSON.parse(String(calls.find((c) => c.sql.includes("INSERT INTO video_processing_jobs"))?.params[3]));
    expect(payload.trim).toEqual({ start_ms: 500, end_ms: null });
    expect(calls.some((c) => c.sql.includes("is_hidden = false"))).toBe(true);
    expect(queue.publishProcessVideoJob).toHaveBeenCalledTimes(1);
  });

  it("admin re-encode re-transcodes a ready clip from the bucket source (16:9 → 9:16 renditions)", async () => {
    respond = (sql) => {
      if (sql.includes("FROM videos v")) return { rows: [{ ...src, status: "ready", last_error_code: null }] };
      if (sql.includes("INSERT INTO video_processing_jobs")) return { rows: [{ id: "j" }] };
      return { rows: [] };
    };
    await expect(reprocessVideo(VID)).rejects.toMatchObject({ code: "not_failed" });
    await expect(reprocessVideo(VID, { reencode: true })).resolves.toHaveProperty("jobId");
  });

  it("refuses permanent errors and missing sources", async () => {
    respond = () => ({ rows: [{ ...src, last_error_code: "duration_too_long" }] });
    await expect(reprocessVideo(VID)).rejects.toMatchObject({ code: "duration_too_long" });
    respond = () => ({ rows: [src] });
    s3.headObject.mockResolvedValueOnce(null);
    await expect(reprocessVideo(VID)).rejects.toMatchObject({ code: "source_missing" });
  });
});

describe("cron publish-scheduled", () => {
  it("publishes only ready videos (moderation gates the feed, not the schedule) and notifies once", async () => {
    process.env.CRON_SECRET = "s3cret";
    respond = (sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("SELECT id FROM videos")) return { rows: [{ id: VID }] };
      if (sql.includes("followers_notified_at") && sql.startsWith("UPDATE")) return { rows: [{ creator_id: "c" }] };
      return { rows: [] };
    };
    const res = await publishScheduled(new Request("http://l/x", { method: "POST", headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    const publish = calls.find((c) => c.sql.includes("scheduled_publish_at <= now()"));
    expect(publish?.sql).toContain("status = 'ready'");
    expect(publish?.sql).not.toContain("moderation_status");
    expect(notify.notifyFollowersNewPost).toHaveBeenCalledTimes(1);
  });
});

describe("înscrierea la misiune (PATCH missionId + POST submit)", () => {
  it("verifică doar statusuri care există pe videos (fără 'published') + moderarea", async () => {
    respond = (sql) =>
      sql.includes("FROM creator_missions") ? { rows: [{ id: "m1", owner_user_id: "seller-user" }] } : { rows: [] };
    const res = await linkVideoToMission({ userId: "u1", videoId: VID, missionId: "11111111-1111-4111-8111-111111111111" });
    expect(res).toEqual({ ok: false, code: "video_not_eligible" });
    const check = calls.find((c) => c.sql.includes("FROM videos"));
    expect(check?.sql).not.toContain("'published'");
    expect(check?.sql).toContain("moderation_status IS DISTINCT FROM 'rejected'");
    expect(check?.params[2]).toEqual(["deleted", "failed", "archived"]);
  });
});
