import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  session: null as { userId: string; role: string } | null,
  stream: null as Record<string, unknown> | null,
  host: new Map<string, string>(),
  viewerSessions: new Map<string, string>(),
  viewers: new Map<string, Set<string>>(),
  mediaActive: true,
  dbQuery: vi.fn(),
  markStreamLive: vi.fn(),
  markStreamEnded: vi.fn(),
  publishLiveState: vi.fn(async () => undefined),
  sfu: {
    createSfuSession: vi.fn(),
    publishTracks: vi.fn(),
    pullTracks: vi.fn(),
    renegotiate: vi.fn(async () => undefined),
    getSfuSession: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ dbQuery: h.dbQuery }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => h.session }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.2.3.4",
}));
vi.mock("@/lib/live/events", () => ({ publishLiveState: h.publishLiveState }));
vi.mock("@/lib/live/lifecycle", () => ({
  markStreamLive: h.markStreamLive,
  markStreamEnded: h.markStreamEnded,
  updateViewerCount: vi.fn(async () => undefined),
}));
vi.mock("@/lib/realtime/sfu", () => ({
  ...h.sfu,
  hasActiveLocalTrack: () => h.mediaActive,
}));
vi.mock("@/lib/live/presence", () => ({
  touchHost: async (id: string, s: string) => void h.host.set(id, s),
  hostSession: async (id: string) => h.host.get(id) ?? null,
  registerViewerSession: async (id: string, s: string) => void h.viewerSessions.set(s, id),
  viewerSessionBelongsTo: async (id: string, s: string) => h.viewerSessions.get(s) === id,
  touchViewer: async (id: string, s: string) => void (h.viewers.get(id) ?? h.viewers.set(id, new Set()).get(id)!).add(s),
  countViewers: async (id: string) => h.viewers.get(id)?.size ?? 0,
  clearPresence: async (id: string) => {
    h.host.delete(id);
    h.viewers.delete(id);
  },
}));

import { POST as publish } from "@/app/api/live/streams/[id]/publish/route";
import { POST as watch, PUT as answer } from "@/app/api/live/streams/[id]/watch/route";
import { POST as heartbeat } from "@/app/api/live/streams/[id]/heartbeat/route";
import { GET as ice } from "@/app/api/live/streams/[id]/ice/route";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: ID }) };
const OFFER = { type: "offer", sdp: "v=0 offer-sdp-body" };

function post(path: string, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost/api/live/streams/${ID}/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function configure(on: boolean) {
  for (const [k, v] of Object.entries({ CF_REALTIME_APP_ID: "app-1", CF_REALTIME_APP_TOKEN: "secret-1", REDIS_URL: "redis://x" })) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
}

beforeEach(() => {
  configure(true);
  h.session = null;
  h.mediaActive = true;
  h.host.clear();
  h.viewerSessions.clear();
  h.viewers.clear();
  h.stream = { id: ID, status: "scheduled", creator_id: CREATOR, sfu_session_id: null, sfu_tracks: [], sfu_published_at: null };
  h.publishLiveState.mockClear();
  h.markStreamLive.mockReset().mockResolvedValue({ id: ID, creator_id: CREATOR, title: "T", prev_status: "scheduled" });
  h.markStreamEnded.mockReset().mockResolvedValue(true);
  h.sfu.createSfuSession.mockReset().mockResolvedValue("sess-new");
  h.sfu.publishTracks.mockReset().mockResolvedValue({ sessionDescription: { type: "answer", sdp: "answer-sdp" }, tracks: [] });
  h.sfu.pullTracks.mockReset().mockResolvedValue({
    sessionDescription: { type: "offer", sdp: "sfu-offer" },
    tracks: [{ trackName: "video", mid: "0" }, { trackName: "audio", mid: "1" }],
  });
  h.sfu.renegotiate.mockClear();
  h.sfu.getSfuSession.mockReset().mockResolvedValue({ tracks: [] });
  h.dbQuery.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM live_streams WHERE id")) return { rows: h.stream ? [h.stream] : [] };
    if (sql.includes("SET provider = 'cf_sfu'")) {
      if (!h.stream || !["scheduled", "live"].includes(String(h.stream.status))) return { rows: [] };
      h.stream = { ...h.stream, sfu_session_id: params[1], sfu_tracks: JSON.parse(String(params[2])), sfu_published_at: "2026-09-27T10:00:00Z" };
      return { rows: [{ status: h.stream.status, sfu_published_at: "2026-09-27T10:00:00Z" }] };
    }
    if (sql.includes("FROM live_streams ls")) return { rows: h.stream ? [{ ...h.stream, title: "T" }] : [] };
    return { rows: [] };
  });
});

const publishBody = { offer: OFFER, tracks: [{ mid: "0", trackName: "video" }, { mid: "1", trackName: "audio" }] };

describe("provider not configured", () => {
  it("every media route answers 503 live_unavailable without CF keys / Redis", async () => {
    configure(false);
    h.session = { userId: CREATOR, role: "creator" };
    for (const res of [
      await publish(post("publish", publishBody), ctx),
      await watch(post("watch", {}), ctx),
      await heartbeat(post("heartbeat", { role: "host", sessionId: "sess-new" }), ctx),
      await ice(new Request(`http://localhost/api/live/streams/${ID}/ice`), ctx),
    ]) {
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("live_unavailable");
    }
    expect(h.sfu.createSfuSession).not.toHaveBeenCalled();
  });
});

describe("POST publish (host only)", () => {
  it("rejects guests (401) and non-owners (403) before touching the SFU", async () => {
    expect((await publish(post("publish", publishBody), ctx)).status).toBe(401);
    h.session = { userId: OTHER, role: "creator" };
    expect((await publish(post("publish", publishBody), ctx)).status).toBe(403);
    expect(h.sfu.createSfuSession).not.toHaveBeenCalled();
  });

  it("rejects ended streams and malformed track lists", async () => {
    h.session = { userId: CREATOR, role: "creator" };
    const dup = { offer: OFFER, tracks: [{ mid: "0", trackName: "video" }, { mid: "1", trackName: "video" }] };
    expect((await publish(post("publish", dup), ctx)).status).toBe(400);
    h.stream = { ...h.stream!, status: "ended" };
    expect((await publish(post("publish", publishBody), ctx)).status).toBe(409);
  });

  it("publishes through the SFU, stores the session, but does NOT go live yet", async () => {
    h.session = { userId: CREATOR, role: "creator" };
    const res = await publish(post("publish", publishBody), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sessionId: "sess-new", answer: { type: "answer" } });
    expect(JSON.stringify(body)).not.toContain("secret-1");
    expect(h.sfu.publishTracks).toHaveBeenCalledWith("sess-new", OFFER, [
      { location: "local", mid: "0", trackName: "video" },
      { location: "local", mid: "1", trackName: "audio" },
    ]);
    expect(h.stream?.sfu_session_id).toBe("sess-new");
    expect(h.host.get(ID)).toBe("sess-new");
    expect(h.markStreamLive).not.toHaveBeenCalled();
  });
});

describe("POST heartbeat (host)", () => {
  beforeEach(() => {
    h.session = { userId: CREATOR, role: "creator" };
    h.stream = { ...h.stream!, sfu_session_id: "sess-host", sfu_tracks: [{ trackName: "video", mid: "0" }] };
  });

  it("goes live on the first heartbeat once the SFU reports active media", async () => {
    const res = await heartbeat(post("heartbeat", { role: "host", sessionId: "sess-host" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("live");
    expect(h.markStreamLive).toHaveBeenCalledWith({ streamId: ID, creatorId: CREATOR });
    expect(h.publishLiveState).toHaveBeenCalledWith(ID, expect.objectContaining({ status: "live" }));
  });

  it("stays scheduled while the SFU has no active track", async () => {
    h.mediaActive = false;
    const res = await heartbeat(post("heartbeat", { role: "host", sessionId: "sess-host" }), ctx);
    expect((await res.json()).status).toBe("scheduled");
    expect(h.markStreamLive).not.toHaveBeenCalled();
  });

  it("rejects a stale tab whose session was replaced, and non-owners", async () => {
    expect((await heartbeat(post("heartbeat", { role: "host", sessionId: "sess-old1" }), ctx)).status).toBe(409);
    h.session = { userId: OTHER, role: "creator" };
    expect((await heartbeat(post("heartbeat", { role: "host", sessionId: "sess-host" }), ctx)).status).toBe(403);
  });
});

describe("watch + viewer heartbeat", () => {
  it("refuses to pull media while the stream is not live", async () => {
    const res = await watch(post("watch", {}), ctx);
    expect(res.status).toBe(409);
    expect(h.sfu.pullTracks).not.toHaveBeenCalled();
  });

  it("pulls the host's tracks for any viewer when live, then accepts only its own answer", async () => {
    h.stream = { ...h.stream!, status: "live", sfu_session_id: "sess-host", sfu_tracks: [{ trackName: "video", mid: "0" }, { trackName: "audio", mid: "1" }] };
    h.host.set(ID, "sess-host");
    const res = await watch(post("watch", {}), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe("sess-new");
    expect(h.sfu.pullTracks).toHaveBeenCalledWith("sess-new", [
      { location: "remote", sessionId: "sess-host", trackName: "video" },
      { location: "remote", sessionId: "sess-host", trackName: "audio" },
    ]);

    const bad = await answer(post("watch", { sessionId: "sess-someone-else", answer: { type: "answer", sdp: "v=0 answer" } }, "PUT"), ctx);
    expect(bad.status).toBe(403);
    const ok = await answer(post("watch", { sessionId: "sess-new", answer: { type: "answer", sdp: "v=0 answer" } }, "PUT"), ctx);
    expect(ok.status).toBe(200);
    expect(h.sfu.renegotiate).toHaveBeenCalledTimes(1);

    const beat = await heartbeat(post("heartbeat", { role: "viewer", sessionId: "sess-new" }), ctx);
    expect(await beat.json()).toMatchObject({ status: "live", viewers: 1 });
  });

  it("ends the stream lazily when a viewer beats after the host heartbeat expired", async () => {
    h.stream = { ...h.stream!, status: "live", sfu_session_id: "sess-host", sfu_tracks: [{ trackName: "video", mid: "0" }] };
    h.viewerSessions.set("sess-view1", ID);
    const res = await heartbeat(post("heartbeat", { role: "viewer", sessionId: "sess-view1" }), ctx);
    expect(await res.json()).toMatchObject({ status: "ended", viewers: 0 });
    expect(h.markStreamEnded).toHaveBeenCalledWith({ streamId: ID }, {});
    expect(h.publishLiveState).toHaveBeenCalledWith(ID, { status: "ended", viewers: 0 });
  });
});
