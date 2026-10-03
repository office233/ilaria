import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ────────────────────────────────────────────────────────────────
let userId: string | null = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
let role: string | null = "creator";
vi.mock("@/lib/creator/session", () => ({
  getCreatorUserId: async () => userId,
  getUserRole: async () => role,
}));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/storage/video-storage", () => ({
  isVideoStorageConfigured: () => true,
  getVideoStorageBucket: () => "media",
  buildRawVideoObjectKey: (u: string, c: string, f: string) => `videos/raw/${c}/${u}/${f}`,
}));

const s3 = vi.hoisted(() => ({
  createMultipartUpload: vi.fn(async () => "mp-1"),
  signUploadParts: vi.fn(async (_k: string, _u: string, nums: number[]) => nums.map((n) => ({ partNumber: n, url: `u${n}` }))),
  listUploadedParts: vi.fn(async (): Promise<Array<{ partNumber: number; etag: string; size: number }>> => []),
  completeMultipartUpload: vi.fn(async () => undefined),
  abortMultipartUpload: vi.fn(async () => undefined),
  headObject: vi.fn(async (): Promise<{ size: number; contentType: string } | null> => ({ size: 20, contentType: "video/mp4" })),
}));
vi.mock("@/lib/video/storage-multipart", () => s3);

const queue = vi.hoisted(() => ({
  publishProcessVideoJob: vi.fn(async (): Promise<{ queued: boolean; backend: string }> => ({ queued: true, backend: "native" })),
}));
vi.mock("@/lib/video/redis-queue", () => queue);

type Q = { sql: string; params: unknown[] };
let dbCalls: Q[] = [];
let dbResponder: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] });
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  dbCalls.push({ sql, params });
  return dbResponder(sql, params);
});
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => query(sql, params),
  getDb: () => ({ connect: async () => ({ query: (sql: string, params?: unknown[]) => query(sql, params), release: () => undefined }) }),
}));

import { GET as listSessions, POST as createSession } from "@/app/api/creator/upload-session/route";
import { DELETE as abortSession, GET as sessionStatus } from "@/app/api/creator/upload-session/[id]/route";
import { POST as signParts } from "@/app/api/creator/upload-session/[id]/parts/route";
import { POST as completeSession } from "@/app/api/creator/upload-session/[id]/complete/route";

const SID = "5f0c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60";
const VID = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const ctx = { params: Promise.resolve({ id: SID }) };

function post(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: SID, user_id: userId, video_id: VID, bucket: "media", object_key: "videos/raw/k.mp4", upload_id: "mp-1",
    status: "uploading", byte_size: "20", content_type: "video/mp4", part_size: "10", total_parts: 2,
    trim_start_ms: null, trim_end_ms: null, expires_at: new Date(Date.now() + 3600_000).toISOString(),
    asset_id: "asset-1", product_refs: [], video_metadata: {}, ...over,
  };
}

beforeEach(() => {
  userId = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  role = "creator";
  dbCalls = [];
  dbResponder = () => ({ rows: [] });
  Object.values(s3).forEach((m) => m.mockClear());
  queue.publishProcessVideoJob.mockClear();
  queue.publishProcessVideoJob.mockResolvedValue({ queued: true, backend: "native" });
});

describe("POST /api/creator/upload-session", () => {
  it("401 without session, 403 for shoppers (sellers are allowed)", async () => {
    userId = null;
    expect((await createSession(post("http://l/x", {}))).status).toBe(401);
    userId = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    role = "shopper";
    expect((await createSession(post("http://l/x", {}))).status).toBe(403);
    role = "seller";
    const res = await createSession(post("http://l/x", { filename: "a.mp4", contentType: "video/mp4", sizeBytes: 25 * 1024 * 1024 }));
    expect(res.status).toBe(201);
  });

  it("rejects files over the shared limit before touching S3", async () => {
    const res = await createSession(post("http://l/x", { filename: "a.mp4", sizeBytes: 10 * 1024 * 1024 * 1024 }));
    expect(res.status).toBe(400);
    expect(s3.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("creates a multipart session with a draft pending-moderation video", async () => {
    const res = await createSession(post("http://l/x", { filename: "IMG_1.MOV", contentType: "", sizeBytes: 25 * 1024 * 1024 }));
    const body = await res.json();
    expect(body.totalParts).toBe(4);
    expect(body.partSize).toBe(8 * 1024 * 1024);
    const insertVideo = dbCalls.find((c) => c.sql.includes("INSERT INTO videos"));
    expect(insertVideo?.sql).toContain("'pending_review'");
    const insertSession = dbCalls.find((c) => c.sql.includes("INSERT INTO video_upload_sessions"));
    expect(insertSession?.params).toContain("mp-1");
    expect(insertSession?.params).toContain("video/quicktime");
  });

  it("aborts the multipart upload if the DB insert fails", async () => {
    dbResponder = (sql) => {
      if (sql.includes("INSERT INTO video_upload_sessions")) throw new Error("db down");
      return { rows: [] };
    };
    const res = await createSession(post("http://l/x", { filename: "a.mp4", sizeBytes: 1024 }));
    expect(res.status).toBe(500);
    expect(s3.abortMultipartUpload).toHaveBeenCalledWith(expect.any(String), "mp-1");
  });

  it("GET lists the user's open sessions for resume", async () => {
    dbResponder = (sql) => (sql.includes("FROM video_upload_sessions vus") ? { rows: [] } : { rows: [] });
    const res = await listSessions();
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toEqual([]);
    expect(dbCalls[0].params[0]).toBe(userId);
  });
});

describe("parts", () => {
  it("signs only part numbers inside the session", async () => {
    dbResponder = (sql) => (sql.includes("FROM video_upload_sessions vus") ? { rows: [sessionRow()] } : { rows: [] });
    const ok = await signParts(post("http://l/x", { partNumbers: [1, 2] }), ctx);
    expect((await ok.json()).parts).toHaveLength(2);
    const bad = await signParts(post("http://l/x", { partNumbers: [3] }), ctx);
    expect(bad.status).toBe(400);
  });

  it("refuses closed or expired sessions", async () => {
    dbResponder = () => ({ rows: [sessionRow({ status: "completed" })] });
    expect((await signParts(post("http://l/x", { partNumbers: [1] }), ctx)).status).toBe(409);
    dbResponder = () => ({ rows: [sessionRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] });
    expect((await signParts(post("http://l/x", { partNumbers: [1] }), ctx)).status).toBe(410);
  });
});

describe("POST /complete", () => {
  it("409 with the missing part numbers when S3 is incomplete (client is not trusted)", async () => {
    dbResponder = (sql) => (sql.includes("FROM video_upload_sessions vus") ? { rows: [sessionRow()] } : { rows: [] });
    s3.listUploadedParts.mockResolvedValueOnce([{ partNumber: 1, etag: "e1", size: 10 }]);
    const res = await completeSession(post("http://l/x", {}), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "upload_incomplete", missing: [2] });
    expect(s3.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("verifies size with HEAD, creates one job and queues it", async () => {
    dbResponder = (sql) => {
      if (sql.includes("FROM video_upload_sessions vus")) return { rows: [sessionRow()] };
      if (sql.includes("SELECT status FROM videos")) return { rows: [{ status: "processing" }] };
      if (sql.includes("INSERT INTO video_processing_jobs")) return { rows: [{ id: "job" }] };
      return { rows: [] };
    };
    s3.listUploadedParts.mockResolvedValueOnce([
      { partNumber: 1, etag: "e1", size: 10 },
      { partNumber: 2, etag: "e2", size: 10 },
    ]);
    const res = await completeSession(post("http://l/x", { trim: { startMs: 1000, endMs: 5000 } }), ctx);
    expect(res.status).toBe(200);
    expect(s3.completeMultipartUpload).toHaveBeenCalled();
    const job = dbCalls.find((c) => c.sql.includes("INSERT INTO video_processing_jobs"));
    expect(job?.sql).toContain("ON CONFLICT (video_id)");
    const payload = JSON.parse(String(job?.params[3]));
    expect(payload.trim).toEqual({ start_ms: 1000, end_ms: 5000 });
    expect(payload.source_url).toBe("");
    expect(queue.publishProcessVideoJob).toHaveBeenCalledTimes(1);
  });

  it("size mismatch after complete → 422", async () => {
    dbResponder = (sql) => (sql.includes("FROM video_upload_sessions vus") ? { rows: [sessionRow()] } : { rows: [] });
    s3.listUploadedParts.mockRejectedValueOnce(new Error("NoSuchUpload"));
    s3.headObject.mockResolvedValueOnce({ size: 19, contentType: "video/mp4" });
    const res = await completeSession(post("http://l/x", {}), ctx);
    expect(res.status).toBe(422);
  });

  it("queue failure is an error (503), not a silent success", async () => {
    dbResponder = (sql) => {
      if (sql.includes("FROM video_upload_sessions vus")) return { rows: [sessionRow({ status: "completed" })] };
      if (sql.includes("SELECT status FROM videos")) return { rows: [{ status: "processing" }] };
      if (sql.includes("INSERT INTO video_processing_jobs")) return { rows: [] };
      if (sql.includes("SELECT id, payload FROM video_processing_jobs")) return { rows: [{ id: "old-job", payload: { job_id: "old-job" } }] };
      return { rows: [] };
    };
    queue.publishProcessVideoJob.mockResolvedValueOnce({ queued: false, backend: "none" });
    const res = await completeSession(post("http://l/x", {}), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("queue_unavailable");
    // idempotent: completed session → no second S3 complete, existing job reused
    expect(s3.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("rejects a trim longer than the max duration", async () => {
    dbResponder = (sql) => (sql.includes("FROM video_upload_sessions vus") ? { rows: [sessionRow()] } : { rows: [] });
    const res = await completeSession(post("http://l/x", { trim: { startMs: 0, endMs: 60 * 60 * 1000 } }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("duration_too_long");
  });
});

describe("GET/DELETE /upload-session/[id]", () => {
  it("returns the real processing status for the owner only", async () => {
    dbResponder = () => ({ rows: [] });
    expect((await sessionStatus(new Request("http://l/x"), ctx)).status).toBe(404);
    dbResponder = () => ({
      rows: [{
        session_id: SID, upload_status: "completed", byte_size: "20", total_parts: 2, video_id: VID, video_status: "processing",
        visibility: "draft", moderation_status: "pending_review", title: "t", thumbnail_url: null, playback_url: null,
        duration_ms: null, width: null, height: null, job_id: "j", job_status: "running", job_stage: "transcoding",
        job_progress: 55, job_error_code: null, attempt_count: 1, max_attempts: 3, created_at: "x",
      }],
    });
    const body = await (await sessionStatus(new Request("http://l/x"), ctx)).json();
    expect(body).toMatchObject({ phase: "processing", stage: "transcoding", progress: 55 });
    expect(dbCalls.at(-1)?.params).toEqual([SID, userId]);
  });

  it("cancel aborts the multipart upload and archives the draft", async () => {
    dbResponder = (sql) => (sql.includes("FROM video_upload_sessions vus") ? { rows: [sessionRow()] } : { rows: [] });
    const res = await abortSession(new Request("http://l/x", { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(s3.abortMultipartUpload).toHaveBeenCalledWith("videos/raw/k.mp4", "mp-1");
    expect(dbCalls.some((c) => c.sql.includes("SET status = 'aborted'"))).toBe(true);
    expect(dbCalls.some((c) => c.sql.includes("SET status = 'deleted'"))).toBe(true);
  });
});
