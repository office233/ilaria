import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbQuery, push, state } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  push: vi.fn(async () => undefined),
  state: { prevStatus: "scheduled" as string | null },
}));

vi.mock("@/lib/db", () => ({ dbQuery }));
vi.mock("@/lib/push/web-push", () => ({ sendPushToUser: push }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => ({ userId: "creator-1", role: "creator" }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

import { POST as createStream } from "@/app/api/live/streams/route";
import { markStreamLive } from "@/lib/live/lifecycle";

const STREAM = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  push.mockClear();
  dbQuery.mockReset();
  state.prevStatus = "scheduled";
  dbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("INSERT INTO live_streams")) return { rows: [{ id: "s-1" }], rowCount: 1 };
    if (sql.includes("UPDATE live_streams ls SET status = 'live'")) {
      return state.prevStatus
        ? { rows: [{ id: STREAM, creator_id: "creator-1", title: "T", prev_status: state.prevStatus }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM follows")) return { rows: [{ follower_user_id: "f-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe("live stream lifecycle", () => {
  it("creates Cloudflare SFU streams as 'scheduled' even without scheduled_at", async () => {
    const res = await createStream(
      new Request("http://localhost/api/live/streams", { method: "POST", body: JSON.stringify({ title: "Show" }) }) as never,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("scheduled");
    const insert = dbQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO live_streams"));
    const params = insert?.[1] as unknown[];
    expect(params.at(-1)).toBe("scheduled");
    expect(params).toContain("cf_sfu");
  });

  it("goes live once and notifies followers once", async () => {
    const went = await markStreamLive({ streamId: STREAM, creatorId: "creator-1" });
    expect(went?.id).toBe(STREAM);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not re-notify when the host reconnects while already live", async () => {
    state.prevStatus = "live";
    await markStreamLive({ streamId: STREAM, creatorId: "creator-1" });
    expect(push).not.toHaveBeenCalled();
  });

  it("does not revive an ended stream", async () => {
    state.prevStatus = null;
    expect(await markStreamLive({ streamId: STREAM })).toBeNull();
  });
});
