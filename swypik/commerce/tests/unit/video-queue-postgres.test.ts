import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const state = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  respond: (_sql: string): { rows: unknown[]; rowCount: number } => ({ rows: [], rowCount: 0 }),
  published: [] as Array<{ channel: string; payload: unknown }>,
  actor: { userId: "admin-1", role: "ops" } as unknown,
  audits: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    return state.respond(sql);
  }),
}));
vi.mock("@/lib/realtime", () => ({
  publishRealtime: vi.fn(async (channel: string, payload: unknown) => {
    state.published.push({ channel, payload });
    return true;
  }),
  realtimeChannels: { videoWakeup: "video:jobs:wakeup" },
}));
vi.mock("@/lib/admin/guard", () => ({ requireAdmin: vi.fn(async () => state.actor) }));
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: vi.fn(async (e: unknown) => state.audits.push(e)) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ success: true, remaining: 10 })) }));

import {
  getVideoQueueMetrics,
  reapExhaustedJobs,
  requeueDeadLetter,
  videoQueueBackend,
} from "@/lib/queue/video-jobs";
import { publishProcessVideoJob } from "@/lib/video/redis-queue";
import { GET, POST } from "@/app/api/admin/video-queue/route";
import type { ProcessVideoJobPayload } from "@/lib/video/upload-session";

const JOB = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  state.queries = [];
  state.published = [];
  state.audits = [];
  state.actor = { userId: "admin-1", role: "ops" };
  state.respond = () => ({ rows: [], rowCount: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("videoQueueBackend", () => {
  it("implicit postgres; stream/list doar explicit", () => {
    vi.stubEnv("VIDEO_QUEUE_BACKEND", "");
    expect(videoQueueBackend()).toBe("postgres");
    vi.stubEnv("VIDEO_QUEUE_BACKEND", "STREAM");
    expect(videoQueueBackend()).toBe("stream");
    vi.stubEnv("VIDEO_QUEUE_BACKEND", "bogus");
    expect(videoQueueBackend()).toBe("postgres");
  });
});

describe("publishProcessVideoJob (coada Postgres)", () => {
  it("rândul 'queued' e coada: doar trezește workerii, fără XADD", async () => {
    vi.stubEnv("VIDEO_QUEUE_BACKEND", "postgres");
    const res = await publishProcessVideoJob({ job_id: JOB } as ProcessVideoJobPayload);
    expect(res).toEqual({ queued: true, backend: "postgres" });
    expect(state.published).toEqual([{ channel: "video:jobs:wakeup", payload: JOB }]);
  });
});

describe("metrici și dead-letter", () => {
  it("normalizează numerele din SQL", async () => {
    state.respond = () => ({
      rows: [{ queued: "3", scheduled_retry: 1, running: 2, expired_leases: 0, dead_letter: "4", failed_24h: 5,
        succeeded_24h: 90, active_workers: 2, oldest_queued_age_s: "12" }],
      rowCount: 1,
    });
    const m = await getVideoQueueMetrics();
    expect(m).toMatchObject({ queued: 3, dead_letter: 4, oldest_queued_age_s: 12, active_workers: 2 });
    expect(state.queries[0].sql).toContain("job_type = 'transcode'");
  });

  it("requeue: doar joburi din dead-letter, fără alt job activ pe clip; trezește workerii", async () => {
    state.respond = (sql) =>
      sql.includes("UPDATE video_processing_jobs") ? { rows: [{ id: JOB, video_id: "v1" }], rowCount: 1 } : { rows: [], rowCount: 1 };
    expect(await requeueDeadLetter(JOB)).toBe(true);
    const upd = state.queries[0].sql;
    expect(upd).toContain("dead_lettered_at IS NOT NULL");
    expect(upd).toContain("NOT EXISTS");
    expect(upd).toContain("attempt_count = 0");
    expect(state.queries[1].sql).toContain("UPDATE videos SET status = 'processing'");
    expect(state.published).toHaveLength(1);
  });

  it("requeue refuzat (nu e în dead-letter) → false, nimic altceva", async () => {
    expect(await requeueDeadLetter(JOB)).toBe(false);
    expect(state.queries).toHaveLength(1);
    expect(state.published).toHaveLength(0);
  });

  it("reap: mută în dead-letter doar joburile fără încercări rămase", async () => {
    state.respond = () => ({ rows: [], rowCount: 2 });
    expect(await reapExhaustedJobs(30)).toBe(2);
    const sql = state.queries[0].sql;
    expect(sql).toContain("attempt_count >= max_attempts");
    expect(sql).toContain("dead_lettered_at = NOW()");
    expect(state.queries[0].params).toEqual([30]);
  });
});

describe("/api/admin/video-queue", () => {
  it("GET întoarce backend, metrici și dead-letter", async () => {
    state.respond = (sql) => (sql.includes("COUNT(*)") ? { rows: [{ queued: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const res = await GET(new Request("http://x/api/admin/video-queue"));
    const body = await res.json();
    expect(body.backend).toBe("postgres");
    expect(body.metrics.queued).toBe(1);
    expect(body.deadLetters).toEqual([]);
  });

  it("neautorizat → răspunsul gărzii", async () => {
    state.actor = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    expect((await GET(new Request("http://x"))).status).toBe(401);
  });

  it("POST requeue validează corpul și auditează", async () => {
    const bad = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "requeue", jobId: "nope" }) }));
    expect(bad.status).toBe(400);

    state.respond = (sql) =>
      sql.includes("UPDATE video_processing_jobs") ? { rows: [{ id: JOB, video_id: "v1" }], rowCount: 1 } : { rows: [], rowCount: 1 };
    const ok = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "requeue", jobId: JOB }) }));
    expect(ok.status).toBe(200);
    expect(state.audits).toHaveLength(1);

    state.respond = () => ({ rows: [], rowCount: 0 });
    const conflict = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "requeue", jobId: JOB }) }));
    expect(conflict.status).toBe(409);
  });
});
