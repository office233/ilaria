import { describe, it, expect } from "vitest";
import { applyFeedEventGuards, capKey, UNKNOWN_DURATION_WATCH_CAP_MS } from "@/lib/feed/event-guards";
import type { NormalizedFeedEvent } from "@/lib/feed/events";
import { signFeedSession, verifyFeedSession, isValidFeedSid } from "@/lib/feed/feed-session";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";

function ev(partial: Partial<NormalizedFeedEvent>): NormalizedFeedEvent {
  return {
    event_type: "video_view",
    video_id: V1,
    watch_ms: null,
    position_ms: null,
    session_id: "sess-12345678",
    metadata: {},
    ...partial,
  };
}

const videos = new Map<string, number | null>([[V1, 10_000], [V2, null]]);

describe("applyFeedEventGuards", () => {
  it("drops events for unknown videos", () => {
    const r = applyFeedEventGuards([ev({ video_id: "33333333-3333-4333-8333-333333333333" })], {
      isAccount: true, videos, priorCounts: new Map(),
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });

  it("clamps watch_ms to duration × factor and strips it from non-watch_time events", () => {
    const r = applyFeedEventGuards(
      [
        ev({ event_type: "watch_time", watch_ms: 6 * 60 * 60 * 1000 }),
        ev({ event_type: "skip_fast", watch_ms: 9_000 }),
      ],
      { isAccount: false, videos, priorCounts: new Map() },
    );
    expect(r.accepted[0].watch_ms).toBe(12_000);
    expect(r.accepted[1].watch_ms).toBeNull();
  });

  it("caps watch_ms when duration is unknown", () => {
    const r = applyFeedEventGuards([ev({ video_id: V2, event_type: "watch_time", watch_ms: 99_999_999 })], {
      isAccount: false, videos, priorCounts: new Map(),
    });
    expect(r.accepted[0].watch_ms).toBe(UNKNOWN_DURATION_WATCH_CAP_MS);
  });

  it("allows a strong signal once per identity per video, within and across batches", () => {
    const batch = [ev({ event_type: "completion" }), ev({ event_type: "completion" })];
    const first = applyFeedEventGuards(batch, { isAccount: false, videos, priorCounts: new Map() });
    expect(first.accepted).toHaveLength(1);
    const again = applyFeedEventGuards([ev({ event_type: "completion" })], {
      isAccount: false, videos, priorCounts: new Map([[capKey(V1, "completion"), 1]]),
    });
    expect(again.accepted).toHaveLength(0);
  });

  it("ignores reports from anonymous identities but keeps them for accounts", () => {
    const anon = applyFeedEventGuards([ev({ event_type: "report" })], { isAccount: false, videos, priorCounts: new Map() });
    expect(anon.accepted).toHaveLength(0);
    const acct = applyFeedEventGuards([ev({ event_type: "report" })], { isAccount: true, videos, priorCounts: new Map() });
    expect(acct.accepted).toHaveLength(1);
  });

  it("applies the soft cap to repeated weak events", () => {
    const many = Array.from({ length: 30 }, () => ev({ event_type: "pause" }));
    const r = applyFeedEventGuards(many, { isAccount: true, videos, priorCounts: new Map() });
    expect(r.accepted).toHaveLength(20);
  });
});

describe("feed session token", () => {
  it("round-trips a signed sid and rejects tampering", () => {
    const token = signFeedSession("abcdef12-3456");
    expect(verifyFeedSession(token)).toBe("abcdef12-3456");
    expect(verifyFeedSession(token.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBeNull();
    expect(verifyFeedSession("abcdef12-3456")).toBeNull();
    expect(verifyFeedSession(null)).toBeNull();
  });

  it("validates sid format", () => {
    expect(isValidFeedSid("short")).toBe(false);
    expect(isValidFeedSid("has.dot.inside")).toBe(false);
    expect(isValidFeedSid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
  });
});
