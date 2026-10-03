import { describe, it, expect, vi, beforeEach } from "vitest";

type Identity = { userId: string; isAnon: boolean } | null;
let identity: Identity = null;
let rateOk = true;

vi.mock("@/lib/social/session", () => ({
  getSocialIdentity: async () => identity,
  getAnonSigningKey: () => "test-key",
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: rateOk, remaining: 1 }),
  getClientIP: () => "1.2.3.4",
}));

const V1 = "11111111-1111-4111-8111-111111111111";
const inserted: unknown[][] = [];
let priorRows: { video_id: string; event_type: string; n: number }[] = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM videos WHERE id = ANY")) {
      return { rows: [{ id: V1, duration_ms: 10_000 }], rowCount: 1 };
    }
    if (sql.includes("FROM feed_events")) return { rows: priorRows, rowCount: priorRows.length };
    if (sql.includes("INSERT INTO feed_events")) {
      inserted.push(params);
      return { rows: [], rowCount: params.length / 10 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import { POST } from "@/app/api/feed/events/batch/route";
import { POST as POST_ONE } from "@/app/api/feed/event/route";
import { signFeedSession } from "@/lib/feed/feed-session";

function req(body: unknown, cookie?: string): Request {
  return new Request("http://localhost/api/feed/events/batch", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  identity = null;
  rateOk = true;
  inserted.length = 0;
  priorRows = [];
});

describe("POST /api/feed/events/batch", () => {
  it("rejects anonymous events without a signed feed session", async () => {
    const res = await POST(req({ events: [{ event_type: "completion", video_id: V1, session_id: "attacker-1" }] }));
    expect(res.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a forged feed_sid cookie", async () => {
    const res = await POST(req({ events: [{ event_type: "completion", video_id: V1 }] }, "feed_sid=abcdefgh-1.deadbeef"));
    expect(res.status).toBe(401);
  });

  it("accepts a signed feed session, forces its sid and dedups completion", async () => {
    const cookie = `feed_sid=${signFeedSession("abcdefgh-1234")}`;
    const res = await POST(
      req(
        {
          events: [
            { event_type: "completion", video_id: V1, session_id: "spoofed-session" },
            { event_type: "completion", video_id: V1 },
            { event_type: "report", video_id: V1 },
            { event_type: "watch_time", video_id: V1, watch_ms: 3_600_000 },
          ],
        },
        cookie,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toBe(2); // duplicate completion + anonymous report
    const params = inserted[0];
    // 2 rows × 10 params; session_id (index 1) is the signed sid, actor null
    expect(params).toHaveLength(20);
    expect(params[0]).toBeNull();
    expect(params[1]).toBe("abcdefgh-1234");
    expect(params[14]).toBe(12_000); // watch_ms clamped to duration × 1.2
  });

  it("drops events already at cap in the DB window", async () => {
    identity = { userId: "u-1", isAnon: false };
    priorRows = [{ video_id: V1, event_type: "completion", n: 1 }];
    const res = await POST(req({ events: [{ event_type: "completion", video_id: V1 }] }));
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });

  it("keeps reports from real accounts", async () => {
    identity = { userId: "u-1", isAnon: false };
    const res = await POST(req({ events: [{ event_type: "report", video_id: V1 }] }));
    expect(res.status).toBe(200);
    expect(inserted[0][0]).toBe("u-1");
  });

  it("returns 429 when rate limited", async () => {
    identity = { userId: "u-1", isAnon: false };
    rateOk = false;
    const res = await POST(req({ events: [{ event_type: "video_view", video_id: V1 }] }));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/feed/event", () => {
  it("returns 400 on invalid event type", async () => {
    const res = await POST_ONE(req({ event_type: "nope" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 without identity", async () => {
    const res = await POST_ONE(req({ event_type: "completion", video_id: V1 }));
    expect(res.status).toBe(401);
  });
});
