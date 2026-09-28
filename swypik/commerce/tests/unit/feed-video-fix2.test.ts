/**
 * Audit 2 feed/upload/video — fix-uri P1/P2: re-moderare la editare, moderarea
 * subtitrărilor, vizibilitate + blocări în feed-uri, sunetul mixat (validare,
 * cheie, re-mix), product-tags, follow din feed, subtitrări publice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let userId: string | null = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
let role: string | null = "creator";
vi.mock("@/lib/creator/session", () => ({
  getCreatorUserId: async () => userId,
  getUserRole: async () => role,
}));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedVideo: vi.fn() }));
vi.mock("@/lib/moderation/labelVideo", () => ({ labelVideo: vi.fn(async () => undefined) }));
vi.mock("@/lib/moderation/strikes", () => ({ recordStrike: vi.fn(async () => undefined) }));
const ai = vi.hoisted(() => ({ moderate: vi.fn(async (_t: string, _f?: string) => ({ flagged: false, reasons: [] as string[] })) }));
vi.mock("@/lib/ai/moderate", () => ai);
vi.mock("@/lib/notifications/dispatch", () => ({ notifyFollowersNewPost: vi.fn(async () => 1) }));
const social = vi.hoisted(() => ({
  viewer: null as string | null,
  isAnon: false,
}));
vi.mock("@/lib/social/session", () => ({
  getOptionalSocialUserId: async () => social.viewer,
  getOrCreateSocialUser: async () => ({ userId: social.viewer, isAnon: social.isAnon }),
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));
vi.mock("@/lib/db/feed-prefs", () => ({
  applyFeedAction: vi.fn(async () => undefined),
  recordFeedEvent: vi.fn(async () => undefined),
  recordWatchEvent: vi.fn(async () => undefined),
}));
const s3 = vi.hoisted(() => ({
  headObject: vi.fn(async (): Promise<{ size: number; contentType: string } | null> => ({ size: 10, contentType: "video/mp4" })),
}));
vi.mock("@/lib/video/storage-multipart", () => s3);
const queue = vi.hoisted(() => ({ publishProcessVideoJob: vi.fn(async () => ({ queued: true, backend: "native" })) }));
vi.mock("@/lib/video/redis-queue", () => queue);

type Q = { sql: string; params: unknown[] };
let calls: Q[] = [];
let respond: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] });
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params });
  return respond(sql, params);
});
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => query(sql, params),
  getDb: () => ({ connect: async () => ({ query: (sql: string, params?: unknown[]) => query(sql, params), release: () => undefined }) }),
  withTransaction: async (fn: (q: typeof query) => Promise<unknown>) => fn(query),
}));

import { CAPTIONS_ENABLED_SQL, notHiddenByViewerSql } from "@/lib/feed/visibility";
import { buildHydrateSql } from "@/lib/feed/hydrate";
import { GET as universal } from "@/app/api/feed/universal/route";
import { PATCH } from "@/app/api/creator/videos/[id]/route";
import { PUT as putCaptions } from "@/app/api/creator/videos/[id]/captions/route";
import { GET as captionList } from "@/app/api/videos/[id]/captions/list/route";
import { GET as getTags, PUT as putTags } from "@/app/api/creator/videos/[id]/product-tags/route";
import { POST as feedAction } from "@/app/api/feed/action/route";
import { GET as audioTracks } from "@/app/api/audio/tracks/route";
import { needsRemoderation, desiredSoundKey } from "@/lib/video/publish";
import { normalizeSoundMix, soundMixKey } from "@/lib/video/sound-mix";
import { moderateVideoText } from "@/lib/video/text-moderation";
import { reprocessVideo } from "@/lib/video/upload/reprocess";
import { toVideoPatch, EMPTY_DETAILS } from "@/lib/upload/details";
import type { OwnedVideo } from "@/lib/video/auth";

const VID = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const OWNER = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PRODUCT = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const ctx = { params: Promise.resolve({ id: VID }) };

function video(over: Partial<OwnedVideo> = {}): OwnedVideo {
  return {
    id: VID, creator_id: OWNER, status: "ready", visibility: "public", moderation_status: "approved",
    published_at: "2026-09-01T00:00:00Z", title: "Titlu", description: "desc", tags: ["vara"], metadata: {},
    audio_track_id: null, ...over,
  };
}

function req(method: string, body?: unknown, url = "http://l/x"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  userId = OWNER;
  role = "creator";
  calls = [];
  respond = () => ({ rows: [] });
  ai.moderate.mockReset();
  ai.moderate.mockImplementation(async () => ({ flagged: false, reasons: [] }));
  social.viewer = null;
  social.isAnon = false;
  queue.publishProcessVideoJob.mockClear();
  delete process.env.VIDEO_MODERATION_MODE;
});

describe("feed: blocări + subtitrări oprite (P1-6, P2-9)", () => {
  it("viewer-ul nu vede clipuri ascunse de el și nici creatori blocați în oricare sens", () => {
    const sql = notHiddenByViewerSql("$2");
    expect(sql).toContain("user_hidden_videos");
    expect(sql).toContain("user_blocks");
    expect(sql).toContain("ub.blocker_user_id = $2::uuid AND ub.blocked_user_id = v.creator_id");
    expect(sql).toContain("ub.blocker_user_id = v.creator_id AND ub.blocked_user_id = $2::uuid");
    expect(notHiddenByViewerSql(null)).toBe("");
  });

  it("hidratarea aplică blocările și respectă comutatorul de subtitrări", () => {
    const { sql } = buildHydrateSql({ userId: OWNER, sessionId: null, softBlock: false });
    expect(sql).toContain("user_blocks");
    expect(sql).toContain(CAPTIONS_ENABLED_SQL);
    expect(CAPTIONS_ENABLED_SQL).toBe("COALESCE(v.metadata->>'captions_enabled', 'true') <> 'false'");
  });
});

describe("GET /api/feed/universal (P1-3)", () => {
  it("folosește regulile comune: fără clipuri ascunse/arhivate sau fără redare; cache public doar anonim", async () => {
    const res = await universal(new Request("http://l/api/feed/universal"));
    expect(res.status).toBe(200);
    const sql = calls[0].sql;
    expect(sql).toContain("v.is_hidden = false");
    expect(sql).toContain("cu.status");
    expect(sql).toContain("movie_episodes");
    expect(sql).toContain("v.playback_url IS NOT NULL");
    expect(sql).not.toContain("user_blocks");
    expect(res.headers.get("cache-control")).toContain("public");
  });

  it("pentru un viewer logat exclude blocările și nu intră în cache public", async () => {
    social.viewer = OWNER;
    const res = await universal(new Request("http://l/api/feed/universal?limit=5", { headers: { cookie: "swypik_session=x" } }));
    expect(calls[0].sql).toContain("user_blocks");
    expect(calls[0].params[0]).toBe(OWNER);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("verticală necunoscută → cod stabil, nu text românesc", async () => {
    const res = await universal(new Request("http://l/api/feed/universal?vertical=nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_vertical");
  });
});

describe("re-moderare la editare (P1-1)", () => {
  it("textul schimbat pe un clip public/aprobat cere moderare; draftul nepublicat nu", () => {
    expect(needsRemoderation({ title: "Alt titlu" }, video())).toBe(true);
    expect(needsRemoderation({ tags: ["#VARA"] }, video())).toBe(false);
    expect(needsRemoderation({ description: "desc" }, video())).toBe(false);
    expect(needsRemoderation({ allow_comments: false }, video())).toBe(false);
    expect(needsRemoderation({ title: "x" }, video({ visibility: "draft", moderation_status: "pending_review", published_at: null }))).toBe(false);
    expect(needsRemoderation({ title: "x" }, video({ visibility: "draft", moderation_status: "approved", published_at: null }))).toBe(true);
  });

  function ownedResponder(fresh: Record<string, unknown> = {}, owned: Partial<OwnedVideo> = {}) {
    return (sql: string) => {
      if (sql.includes("FROM videos WHERE id = $1 AND status <> 'deleted'")) return { rows: [video(owned)] };
      if (sql.startsWith("SELECT status, visibility, moderation_status")) {
        return { rows: [{ status: "ready", visibility: "public", moderation_status: "approved", title: "Nou", description: "desc", tags: ["vara"], ...fresh }] };
      }
      if (sql.includes("FROM audio_tracks")) return { rows: [{ ok: true }] };
      return { rows: [] };
    };
  }

  it("PATCH doar cu titlu pe un clip aprobat: Content Safety semnalează → pending_review, nu mai e live", async () => {
    respond = ownedResponder();
    ai.moderate.mockResolvedValueOnce({ flagged: true, reasons: ["hate:6"] });
    const res = await PATCH(req("PATCH", { title: "text urât" }), ctx);
    const body = await res.json();
    expect(body).toMatchObject({ moderationStatus: "pending_review", liveNow: false });
    const stored = calls.find((c) => c.sql.startsWith("UPDATE videos SET moderation_status"));
    expect(stored?.params).toEqual([VID, "pending_review"]);
    expect(calls.some((c) => c.sql.includes("INSERT INTO moderation_cases"))).toBe(true);
  });

  it("PATCH fără schimbare de text nu apelează moderarea", async () => {
    respond = ownedResponder();
    await PATCH(req("PATCH", { allow_comments: false }), ctx);
    expect(ai.moderate).not.toHaveBeenCalled();
  });
});

describe("sunetul ales: validare + mix (P1-4, P2-8)", () => {
  it("cheia mixului e identică cu cea din worker (sound_mix.py)", () => {
    expect(soundMixKey(7, { volume: 80, original_volume: 50, keep_original: true, loop: false, start_ms: 1500 })).toBe(
      "t7-v80-o50-k1-l0-s1500",
    );
    expect(soundMixKey(null, {})).toBe("none");
    expect(soundMixKey("5", null)).toBe("t5-v100-o100-k1-l1-s0");
    expect(normalizeSoundMix({ volume: 999, original_volume: -4, keep_original: "da" })).toEqual({
      volume: 200, original_volume: 0, keep_original: true, loop: true, start_ms: 0,
    });
    expect(desiredSoundKey({ audio_track_id: 5, sound_mix: {}, track_mixable: false })).toBe("none");
  });

  it("o piesă inexistentă / nelicențiată → 422 invalid_audio_track (nu FK → 500)", async () => {
    respond = (sql) => {
      if (sql.includes("FROM videos WHERE id = $1 AND status <> 'deleted'")) return { rows: [video()] };
      if (sql.includes("FROM audio_tracks")) return { rows: [{ ok: false }] };
      return { rows: [] };
    };
    const res = await PATCH(req("PATCH", { audio_track_id: 99 }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_audio_track");
    expect(calls.some((c) => c.sql.startsWith("UPDATE videos SET"))).toBe(false);
  });

  it("piesa deja legată (chiar dezactivată între timp) nu blochează salvarea", async () => {
    respond = (sql) => {
      if (sql.includes("FROM videos WHERE id = $1 AND status <> 'deleted'")) return { rows: [video({ audio_track_id: "5" })] };
      if (sql.startsWith("SELECT status, visibility, moderation_status")) {
        return { rows: [{ status: "ready", visibility: "public", moderation_status: "approved", title: "Titlu", description: "desc", tags: ["vara"], audio_track_id: 5, track_mixable: false, sound_mixed_key: null }] };
      }
      return { rows: [] };
    };
    const res = await PATCH(req("PATCH", { audio_track_id: 5 }), ctx);
    expect(res.status).toBe(200);
    // isMixableTrack (… AS ok) nu rulează pentru piesa deja legată.
    expect(calls.some((c) => c.sql.includes("AS ok"))).toBe(false);
  });

  it("sunet schimbat pe un clip procesat → re-transcodare (reencode) + setările în metadata", async () => {
    respond = (sql) => {
      if (sql.includes("FROM videos WHERE id = $1 AND status <> 'deleted'")) return { rows: [video()] };
      if (sql.includes("SELECT EXISTS")) return { rows: [{ ok: true }] };
      if (sql.startsWith("SELECT status, visibility, moderation_status")) {
        return { rows: [{ status: "ready", visibility: "public", moderation_status: "approved", title: "Titlu", description: "desc", tags: ["vara"], audio_track_id: 7, sound_mix: { volume: 60 }, sound_mixed_key: "none", track_mixable: true }] };
      }
      if (sql.includes("JOIN video_upload_sessions vus")) {
        return { rows: [{ session_id: "s", user_id: OWNER, bucket: "media", object_key: "k", content_type: "video/mp4", byte_size: 10, trim_start_ms: null, trim_end_ms: null, asset_id: "a", status: "ready", product_refs: [], metadata: {}, last_error_code: null }] };
      }
      if (sql.includes("INSERT INTO video_processing_jobs")) return { rows: [{ id: "j" }] };
      return { rows: [] };
    };
    const res = await PATCH(req("PATCH", { audio_track_id: 7, sound_mix: { volume: 60, keep_original: false } }), ctx);
    const body = await res.json();
    expect(body).toMatchObject({ soundMix: "remixing", status: "processing", liveNow: false });
    const update = calls.find((c) => c.sql.startsWith("UPDATE videos SET") && c.sql.includes("metadata = metadata ||"));
    expect(JSON.parse(String(update?.params.find((p) => typeof p === "string" && p.includes("sound_mix"))))).toMatchObject({
      sound_mix: { volume: 60, keep_original: false, loop: true },
    });
    // Remixul nu scoate din „ascuns” un clip ascuns de moderare (P2-14).
    const reprocessUpdate = calls.find((c) => c.sql.includes("SET status = 'processing'"));
    expect(reprocessUpdate?.sql).not.toContain("is_hidden");
    expect(queue.publishProcessVideoJob).toHaveBeenCalledTimes(1);
  });

  it("clip deja mixat cu aceleași setări → fără re-transcodare", async () => {
    respond = (sql) => {
      if (sql.includes("FROM videos WHERE id = $1 AND status <> 'deleted'")) return { rows: [video({ audio_track_id: 7 })] };
      if (sql.startsWith("SELECT status, visibility, moderation_status")) {
        return { rows: [{ status: "ready", visibility: "public", moderation_status: "approved", title: "Titlu", description: "desc", tags: ["vara"], audio_track_id: 7, sound_mix: null, sound_mixed_key: "t7-v100-o100-k1-l1-s0", track_mixable: true }] };
      }
      return { rows: [] };
    };
    const body = await (await PATCH(req("PATCH", { audio_track_id: 7 }), ctx)).json();
    expect(body.soundMix).toBeUndefined();
    expect(queue.publishProcessVideoJob).not.toHaveBeenCalled();
  });

  it("toVideoPatch trimite mixul doar când există un sunet ales", () => {
    expect(toVideoPatch(EMPTY_DETAILS, "draft").sound_mix).toBeUndefined();
    const body = toVideoPatch({ ...EMPTY_DETAILS, audioTrackId: 3, soundVolume: 55, soundKeepOriginal: false }, "public");
    expect(body.sound_mix).toEqual({ volume: 55, original_volume: 100, keep_original: false, loop: true });
  });

  it("GET /api/audio/tracks?id= întoarce doar piesa licențiată cerută; id invalid → 400", async () => {
    respond = () => ({ rows: [] });
    const res = await audioTracks(new Request("http://l/api/audio/tracks?id=12"));
    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain("licensed_for_commercial = true");
    expect(calls[0].sql).toContain("id = $1");
    expect(calls[0].params[0]).toBe(12);
    expect((await audioTracks(new Request("http://l/api/audio/tracks?id=1;drop"))).status).toBe(400);
  });

  it("reîncercarea unui draft eșuat (fără reencode) încă scoate clipul din ascuns", async () => {
    respond = (sql) => {
      if (sql.includes("JOIN video_upload_sessions vus")) {
        return { rows: [{ session_id: "s", user_id: OWNER, bucket: "media", object_key: "k", content_type: null, byte_size: 1, trim_start_ms: null, trim_end_ms: null, asset_id: "a", status: "failed", product_refs: [], metadata: {}, last_error_code: null }] };
      }
      if (sql.includes("INSERT INTO video_processing_jobs")) return { rows: [{ id: "j" }] };
      return { rows: [] };
    };
    await reprocessVideo(VID);
    expect(calls.find((c) => c.sql.includes("SET status = 'processing'"))?.sql).toContain("is_hidden = false");
  });
});

describe("moderarea subtitrărilor (P1-2, P2-10)", () => {
  it("text semnalat → caz de moderare + clipul aprobat trece în pending_review", async () => {
    ai.moderate.mockResolvedValueOnce({ flagged: true, reasons: ["sexual:6"] });
    const out = await moderateVideoText({ videoId: VID, text: "ceva", kind: "captions" });
    expect(out).toEqual({ held: true, reasons: ["sexual:6"] });
    const hold = calls.find((c) => c.sql.includes("SET moderation_status = 'pending_review'"));
    expect(hold?.sql).toContain("moderation_status = 'approved'");
    expect(calls.some((c) => c.sql.includes("INSERT INTO moderation_cases"))).toBe(true);
  });

  it("text curat sau gol → nimic", async () => {
    expect(await moderateVideoText({ videoId: VID, text: "  ", kind: "speech" })).toEqual({ held: false, reasons: [] });
    expect(await moderateVideoText({ videoId: VID, text: "salut", kind: "speech" })).toEqual({ held: false, reasons: [] });
    expect(calls.length).toBe(0);
  });

  it("PUT subtitrări: textul editat trece prin Content Safety; semnalat → held", async () => {
    respond = (sql) => (sql.includes("FROM videos WHERE id = $1 AND status <> 'deleted'") ? { rows: [video()] } : { rows: [] });
    ai.moderate.mockResolvedValueOnce({ flagged: true, reasons: ["hate:6"] });
    const res = (await putCaptions(req("PUT", { lang: "ro", segments: [{ start: 0, end: 1, text: "text urât" }] }), ctx))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ held: true, track: { lang: "ro", is_auto: false } });
    expect(ai.moderate).toHaveBeenCalledWith("text urât", "video-captions");
  });

  it("lista publică de subtitrări aplică vizibilitatea clipului (fără oracol pentru drafturi)", async () => {
    await captionList(new Request(`http://l/api/videos/${VID}/captions/list`), { params: Promise.resolve({ id: VID }) });
    expect(calls[0].sql).toContain("JOIN videos v");
    expect(calls[0].sql).toContain("v.effective_label = 'safe'");
    expect(calls[0].sql).toContain(CAPTIONS_ENABLED_SQL);
  });
});

describe("product-tags (P2-7)", () => {
  const tags = { tags: [{ product_id: PRODUCT, start_ms: 0 }] };

  it("fără rol de autor → 403; clip străin → 403; clip inexistent → 404", async () => {
    role = "shopper";
    expect((await putTags(req("PUT", tags), ctx))!.status).toBe(403);
    role = "creator";
    respond = (sql) => (sql.includes("status <> 'deleted'") ? { rows: [video({ creator_id: "other" })] } : { rows: [] });
    expect((await putTags(req("PUT", tags), ctx))!.status).toBe(403);
    respond = () => ({ rows: [] });
    expect((await getTags(req("GET"), ctx))!.status).toBe(404);
  });

  it("produs neeligibil/inexistent → 422, fără scriere; eligibil → înlocuire atomică", async () => {
    respond = (sql) => (sql.includes("status <> 'deleted'") ? { rows: [video()] } : { rows: [] });
    const bad = (await putTags(req("PUT", tags), ctx))!;
    expect(bad.status).toBe(422);
    expect((await bad.json()).code).toBe("product_not_eligible");
    expect(calls.some((c) => c.sql.includes("INSERT INTO video_product_links"))).toBe(false);

    respond = (sql) => {
      if (sql.includes("status <> 'deleted'")) return { rows: [video()] };
      if (sql.includes("FROM marketplace_products p")) return { rows: [{ id: PRODUCT }] };
      return { rows: [] };
    };
    const ok = (await putTags(req("PUT", tags), ctx))!;
    expect(ok.status).toBe(200);
    expect(calls.some((c) => c.sql.includes("INSERT INTO video_product_links"))).toBe(true);
  });
});

describe("follow_creator din feed (P2-11)", () => {
  const body = { video_id: VID, action: "follow_creator" };
  const actionReq = () => new Request("http://l/api/feed/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;

  it("anonim → 401; clip invizibil → 404; propriul clip → 400; blocare → 403", async () => {
    social.viewer = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    social.isAnon = true;
    expect((await feedAction(actionReq())).status).toBe(401);

    social.isAnon = false;
    respond = (sql) => (sql.includes("SELECT creator_id FROM videos") ? { rows: [{ creator_id: OWNER }] } : { rows: [] });
    expect((await feedAction(actionReq())).status).toBe(404);

    respond = (sql) => {
      if (sql.includes("SELECT creator_id FROM videos")) return { rows: [{ creator_id: social.viewer }] };
      if (sql.includes("status = 'ready'")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    };
    expect((await feedAction(actionReq())).status).toBe(400);

    respond = (sql) => {
      if (sql.includes("SELECT creator_id FROM videos")) return { rows: [{ creator_id: OWNER }] };
      if (sql.includes("status = 'ready'")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM user_blocks")) return { rows: [{ blocked: true }] };
      return { rows: [] };
    };
    expect((await feedAction(actionReq())).status).toBe(403);
    expect(calls.some((c) => c.sql.includes("INSERT INTO follows"))).toBe(false);
  });

  it("cont real + clip vizibil → follow", async () => {
    social.viewer = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    respond = (sql) => {
      if (sql.includes("SELECT creator_id FROM videos")) return { rows: [{ creator_id: OWNER }] };
      if (sql.includes("status = 'ready'")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM user_blocks")) return { rows: [{ blocked: false }] };
      return { rows: [] };
    };
    expect((await feedAction(actionReq())).status).toBe(204);
    expect(calls.some((c) => c.sql.includes("INSERT INTO follows"))).toBe(true);
  });
});
