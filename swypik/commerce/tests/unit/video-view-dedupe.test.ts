import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  readAnonId: vi.fn(),
  getOrCreateAnonId: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/auth/getAuthUser", () => ({
  getSessionUserId: h.getSessionUserId,
}));
vi.mock("@/lib/anon/session", () => ({
  readAnonId: h.readAnonId,
  getOrCreateAnonId: h.getOrCreateAnonId,
}));
vi.mock("@/lib/security/secret-box", () => ({
  deriveServerSecret: (_purpose: string, input: string) => `hash:${input}`,
}));
vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) => fn(h.query),
}));

import {
  recordDedupedVideoView,
  resolveVideoViewerIdentity,
  type VideoViewerIdentity,
} from "@/lib/video/view-dedupe";

beforeEach(() => {
  h.getSessionUserId.mockReset().mockResolvedValue(null);
  h.readAnonId.mockReset().mockResolvedValue(null);
  h.getOrCreateAnonId.mockReset().mockResolvedValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  h.query.mockReset();
});

describe("resolveVideoViewerIdentity", () => {
  it("uses the authenticated user as canonical identity and keeps the anon alias", async () => {
    h.getSessionUserId.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    h.readAnonId.mockResolvedValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const identity = await resolveVideoViewerIdentity();
    expect(identity).toEqual({
      canonicalKey: "hash:user:11111111-1111-4111-8111-111111111111",
      aliases: [
        "hash:user:11111111-1111-4111-8111-111111111111",
        "hash:anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ],
      kind: "user",
      lockKey: "hash:anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(h.getOrCreateAnonId).not.toHaveBeenCalled();
  });

  it("creates a durable first-party anonymous identity when no user is logged in", async () => {
    const identity = await resolveVideoViewerIdentity();
    expect(identity).toEqual({
      canonicalKey: "hash:anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      aliases: ["hash:anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      kind: "anon",
      lockKey: "hash:anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });
});

describe("recordDedupedVideoView", () => {
  const identity: VideoViewerIdentity = {
    canonicalKey: "user-key",
    aliases: ["user-key", "anon-key"],
    kind: "user",
    lockKey: "anon-key",
  };

  it("increments a ready video only after claiming the persistent dedupe row", async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT viewer_key, last_counted_at")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO video_view_dedup")) {
        return { rows: [{ video_id: "video-1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE videos")) {
        return { rows: [{ view_count: "11" }], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });

    await expect(recordDedupedVideoView("video-1", identity)).resolves.toEqual({
      found: true,
      counted: true,
      views: 11,
    });
  });

  it("bridges a recent anonymous view to the logged-in user without incrementing twice", async () => {
    const sqls: string[] = [];
    h.query.mockImplementation(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT viewer_key, last_counted_at")) {
        return {
          rows: [{
            viewer_key: "anon-key",
            last_counted_at: "2026-09-29T20:00:00Z",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO video_view_dedup")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT view_count")) {
        return { rows: [{ view_count: 10 }], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });

    await expect(recordDedupedVideoView("video-1", identity)).resolves.toEqual({
      found: true,
      counted: false,
      views: 10,
    });
    expect(sqls.some((sql) => sql.includes("UPDATE videos"))).toBe(false);
  });

  it("returns not found when the target is not a ready video", async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT viewer_key, last_counted_at")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO video_view_dedup")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT view_count")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected sql: ${sql}`);
    });

    await expect(recordDedupedVideoView("video-missing", identity)).resolves.toEqual({
      found: false,
      counted: false,
      views: null,
    });
  });
});

describe("recordDedupedVideoView count gate", () => {
  const anon: VideoViewerIdentity = {
    canonicalKey: "anon-key",
    aliases: ["anon-key"],
    kind: "anon",
    lockKey: "anon-key",
  };

  function mockNewViewer() {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT viewer_key, last_counted_at")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO video_view_dedup")) {
        return { rows: [{ video_id: "video-1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE videos")) return { rows: [{ view_count: 11 }], rowCount: 1 };
      if (sql.includes("SELECT view_count")) return { rows: [{ view_count: 10 }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  it("does not count or claim a dedupe row when the gate refuses", async () => {
    mockNewViewer();
    const gate = vi.fn().mockResolvedValue(false);
    const result = await recordDedupedVideoView("video-1", anon, gate);
    expect(result).toEqual({ found: true, counted: false, views: 10 });
    expect(gate).toHaveBeenCalledTimes(1);
    const sqls = h.query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes("INSERT INTO video_view_dedup"))).toBe(false);
    expect(sqls.some((sql) => sql.includes("UPDATE videos"))).toBe(false);
  });

  it("counts when the gate allows", async () => {
    mockNewViewer();
    const result = await recordDedupedVideoView("video-1", anon, async () => true);
    expect(result).toEqual({ found: true, counted: true, views: 11 });
  });

  it("does not consume the gate for a deduped repeat view", async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT viewer_key, last_counted_at")) {
        return { rows: [{ viewer_key: "anon-key", last_counted_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("SELECT view_count")) return { rows: [{ view_count: 10 }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const gate = vi.fn().mockResolvedValue(true);
    const result = await recordDedupedVideoView("video-1", anon, gate);
    expect(result.counted).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
});
