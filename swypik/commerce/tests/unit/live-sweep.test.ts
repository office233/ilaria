import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; provider: string }>,
  alive: new Set<string>(),
  markStreamEnded: vi.fn(async () => true),
  updateViewerCount: vi.fn(async () => undefined),
  publishLiveState: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: h.rows })) }));
vi.mock("@/lib/live/events", () => ({ publishLiveState: h.publishLiveState }));
vi.mock("@/lib/live/lifecycle", () => ({
  markStreamLive: vi.fn(),
  markStreamEnded: h.markStreamEnded,
  updateViewerCount: h.updateViewerCount,
}));
vi.mock("@/lib/live/presence", () => ({
  hostSession: async (id: string) => (h.alive.has(id) ? "sess" : null),
  countViewers: async () => 7,
  clearPresence: async () => undefined,
  touchHost: vi.fn(),
  registerViewerSession: vi.fn(),
  viewerSessionBelongsTo: vi.fn(),
  touchViewer: vi.fn(),
}));

import { sweepLiveStreams } from "@/lib/live/sweep";

beforeEach(() => {
  h.alive.clear();
  h.markStreamEnded.mockClear();
  h.updateViewerCount.mockClear();
  h.publishLiveState.mockClear();
});

describe("sweepLiveStreams", () => {
  it("ends SFU streams whose host heartbeat expired and refreshes viewer counts for the others", async () => {
    h.rows = [
      { id: "s-dead", provider: "cf_sfu" },
      { id: "s-alive", provider: "cf_sfu" },
    ];
    h.alive.add("s-alive");
    const res = await sweepLiveStreams();
    expect(res).toEqual({ checked: 2, ended: 1, updated: 1, legacyEnded: 0 });
    expect(h.markStreamEnded).toHaveBeenCalledWith({ streamId: "s-dead" }, {});
    expect(h.updateViewerCount).toHaveBeenCalledWith("s-alive", 7);
    expect(h.publishLiveState).toHaveBeenCalledWith("s-alive", { status: "live", viewers: 7 });
    expect(h.publishLiveState).toHaveBeenCalledWith("s-dead", { status: "ended", viewers: 0 });
  });

  it("ends 'live' rows left on the removed LiveKit / RTMP providers", async () => {
    h.rows = [{ id: "s-old", provider: "livekit" }];
    const res = await sweepLiveStreams();
    expect(res.legacyEnded).toBe(1);
    expect(h.markStreamEnded).toHaveBeenCalledWith({ streamId: "s-old" }, {});
  });
});
