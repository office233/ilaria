import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Review Focus #3/#4: schimbarea stării piesei și alinierea `audio_tracks`
 * se întâmplă în ACEEAȘI tranzacție (același `q`), iar o piesă care nu mai
 * poate fi sunet public (premium / fără allow_reels) își dezactivează rândul.
 */
const calls: Array<{ sql: string; params: unknown[] }> = [];
let trackAfterUpdate: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) => fn(query),
  dbQuery: vi.fn(async () => { throw new Error("dbQuery must not be used inside the transaction"); }),
}));

const artist = { user_id: "a1", stage_name: "Zara", slug: "zara", bio: "", avatar_url: null, cover_url: null, approved_at: "", created_at: "", updated_at: "" };
const base = {
  id: "t1", artist_user_id: "a1", album_id: null, track_number: null, title: "Vara", slug: "vara-1", cover_url: null, genre: "pop",
  duration_ms: 120_000, explicit: false, object_key: "music/raw/a1/t1/abc.m4a", public_url: "https://cdn/music/raw/a1/t1/abc.m4a",
  is_premium: false, price_units: null, price_cents: null, allow_reels: true, audio_track_id: 7, audience: "general", status: "published",
  moderation_status: "approved", license_note: "ok", published_at: "2026-09-22T00:00:00Z", created_at: "", updated_at: "",
};

async function query(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (sql.startsWith("UPDATE music_tracks SET")) return { rows: trackAfterUpdate ? [trackAfterUpdate] : [], rowCount: trackAfterUpdate ? 1 : 0 };
  if (sql.startsWith("SELECT * FROM music_artists")) return { rows: [artist], rowCount: 1 };
  if (sql.startsWith("INSERT INTO audio_tracks")) return { rows: [{ id: 7 }], rowCount: 1 };
  if (sql.startsWith("UPDATE audio_tracks SET is_active = false")) return { rows: [], rowCount: 1 };
  if (sql.startsWith("UPDATE music_tracks SET audio_track_id")) return { rows: [], rowCount: 1 };
  throw new Error("unexpected sql: " + sql.slice(0, 60));
}

import { updateTrackAndSync } from "@/lib/music/publish";

beforeEach(() => { calls.length = 0; trackAfterUpdate = null; });

describe("music/publish updateTrackAndSync", () => {
  it("allow_reels retras pe o piesa publicata => UPDATE + dezactivarea sunetului, in aceeasi tranzactie", async () => {
    trackAfterUpdate = { ...base, allow_reels: false };
    const updated = await updateTrackAndSync("t1", "a1", { allowReels: false });
    expect(updated?.allow_reels).toBe(false);
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toMatch(/^UPDATE music_tracks SET allow_reels = \$3/);
    expect(calls[0].params).toEqual(["t1", "a1", false]);
    expect(sqls.some((s) => s.startsWith("UPDATE audio_tracks SET is_active = false"))).toBe(true);
    expect(calls.find((c) => c.sql.startsWith("UPDATE audio_tracks SET is_active = false"))?.params).toEqual([7]);
    expect(sqls.some((s) => s.startsWith("INSERT INTO audio_tracks"))).toBe(false);
  });
  it("trecerea la premium (fara URL public) dezactiveaza sunetul", async () => {
    trackAfterUpdate = { ...base, is_premium: true, public_url: null, price_units: "300", price_cents: "300" };
    await updateTrackAndSync("t1", null, { isPremium: true, publicUrl: null, priceCents: 300 });
    expect(calls.some((c) => c.sql.startsWith("UPDATE audio_tracks SET is_active = false"))).toBe(true);
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO audio_tracks"))).toBe(false);
  });
  it("reactivarea allow_reels pe o piesa gratuita publicata re-creeaza/reactiveaza sunetul", async () => {
    trackAfterUpdate = { ...base, allow_reels: true };
    await updateTrackAndSync("t1", "a1", { allowReels: true });
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO audio_tracks"))).toBe(true);
    expect(calls.some((c) => c.sql.startsWith("UPDATE music_tracks SET audio_track_id"))).toBe(true);
  });
  it("piesa inexistenta sau a altui artist => null, fara alte query-uri", async () => {
    trackAfterUpdate = null;
    expect(await updateTrackAndSync("t1", "other", { allowReels: false })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
