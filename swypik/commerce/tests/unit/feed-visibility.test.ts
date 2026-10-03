import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { sql: string; params: unknown[] }[] = [];
let rows: Record<string, unknown>[] = [];
let moviesOn = false;

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows, rowCount: rows.length };
  }),
}));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: (name: string) => (name === "movies" ? moviesOn : false) }));
vi.mock("@/lib/missions/feed-badge", () => ({
  getMissionBadges: async (ids: string[]) =>
    new Map(ids.filter((id) => id === "v2").map((id) => [id, { missionId: "m", slug: "s", title: "M", prizeCents: 5000, currency: "RON", open: true, winner: false }])),
}));

import { buildHydrateSql, hydrateVideos } from "@/lib/feed/hydrate";
import { toFeedVideo, type HydratedRow } from "@/lib/feed/dto";
import { visibleVideoSql, productAttachSql } from "@/lib/feed/visibility";
import { keysetPage } from "@/lib/feed/keyset";

function row(over: Partial<HydratedRow>): HydratedRow {
  return {
    video_id: "v1", creator_id: "c1", description: "desc", title: null, playback_url: "https://cdn/x/master.m3u8",
    thumbnail_url: null, duration_ms: 15000, like_count: 3, save_count: "2", share_count: null, comment_count: 1,
    creator_name: "Ana", creator_username: "ana", creator_verified: true, creator_avatar: null, source_key: "videos/v1.mp4",
    preview_url: "https://cdn/x/preview.mp4", mp_id: null, mp_title: null, mp_price_cents: null, mp_image_url: null,
    mp_currency: null, mp_inventory_status: null, mp_shipping_cost_cents: null, mp_taxonomy_node_slug: null, mp_metadata: null,
    product_placement: null, worth_it_count: 0, not_worth_it_count: 0, viewer_product_vote: null, at_id: null, at_title: null,
    at_artist: null, at_image_url: null, movie_slug: null, movie_title: null, movie_episode_number: null, movie_episode_count: null,
    caption_langs: ["ro", "en", "bad-lang"], viewer_liked: false, viewer_saved: true, viewer_following: false,
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  rows = [];
  moviesOn = false;
});

describe("reguli de vizibilitate", () => {
  it("poarta de moderare: doar ready + public + neascuns + effective_label safe + creator activ", () => {
    const sql = visibleVideoSql();
    expect(sql).toContain("v.status = 'ready'");
    expect(sql).toContain("v.is_hidden = false");
    expect(sql).toContain("v.visibility = 'public'");
    expect(sql).toContain("v.effective_label = 'safe'");
    expect(sql).toContain("cu.status");
  });

  it("episoadele de film: ascunse cu flag-ul oprit, doar cele gratuite/publicate cu flag pornit", () => {
    expect(visibleVideoSql()).toMatch(/NOT EXISTS \(SELECT 1 FROM movie_episodes me WHERE me\.video_id = v\.id\)/);
    moviesOn = true;
    expect(visibleVideoSql()).toContain("me.episode_number <= ms.free_episodes");
  });

  it("produsul arhivat NU ascunde clipul: eligibilitatea e în ON-ul LEFT JOIN, nu în WHERE", () => {
    const { sql } = buildHydrateSql({ userId: null, sessionId: null, softBlock: true });
    const join = sql.slice(sql.indexOf("LEFT JOIN marketplace_products p"), sql.indexOf("LEFT JOIN audio_tracks"));
    expect(join).toContain("p.status = 'active'");
    const where = sql.slice(sql.lastIndexOf("WHERE v.id = ANY"));
    expect(where).not.toContain("p.status");
    expect(where).toContain("v.effective_label = 'safe'");
  });

  it("blocklist-ul de produse e mereu aplicat; soft-block doar la cerere", () => {
    expect(productAttachSql({ softBlock: false })).toContain("lingerie");
    expect(productAttachSql({ softBlock: false })).not.toContain("swimwear");
    expect(productAttachSql({ softBlock: true })).toContain("swimwear");
  });

  it("parametrii: fără user nu se leagă parametri nefolosiți", () => {
    expect(buildHydrateSql({ userId: null, sessionId: null, softBlock: false }).params).toHaveLength(1);
    const withUser = buildHydrateSql({ userId: "u", sessionId: "s", softBlock: false });
    expect(withUser.params).toEqual([[], "u", "s"]);
    expect(withUser.sql).toContain("user_hidden_videos");
  });
});

describe("hidratare + DTO", () => {
  it("păstrează ordinea clasamentului, omite clipurile dispărute, atașează badge-ul de misiune", async () => {
    rows = [row({ video_id: "v2" }), row({ video_id: "v1" })];
    const out = await hydrateVideos(["v1", "gone", "v2"], { userId: null, sessionId: null, softBlock: true });
    expect(out.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(out[1].mission?.slug).toBe("s");
    expect(out[0].mission).toBeNull();
    expect(calls[0].params[0]).toEqual(["v1", "gone", "v2"]);
  });

  it("clip fără produs eligibil → product null; HLS + MP4 de rezervă; subtitrări validate", () => {
    const v = toFeedVideo(row({}), "https://media.test/", null);
    expect(v.product).toBeNull();
    expect(v.hlsUrl).toBe("https://cdn/x/master.m3u8");
    expect(v.fallbackUrl).toBe("https://cdn/x/preview.mp4");
    expect(v.captionLangs).toEqual(["ro", "en"]);
    expect(v.saves).toBe(2);
    expect(v.shares).toBe(0);
    expect(v.duration).toBe(15);
  });

  it("produs eligibil → card de produs fără texte traduse pe server", () => {
    const v = toFeedVideo(
      row({ mp_id: "p1", mp_title: "Cană", mp_price_cents: "4999", mp_currency: "ron", mp_shipping_cost_cents: 0, mp_metadata: { vertical: "fly" } }),
      "",
      null,
    );
    expect(v.product).toMatchObject({ id: "p1", priceCents: 4999, currency: "RON", shippingCents: 0, vertical: "fly" });
    expect(JSON.stringify(v.product)).not.toMatch(/Livrare/);
  });
});

describe("keyset (Following / categorie / profil)", () => {
  it("paginează după (published_at, id) fără OFFSET și întoarce cursorul cu microsecunde", async () => {
    rows = [
      { id: "a", published_key: "2026-09-26T10:00:00.000003Z" },
      { id: "b", published_key: "2026-09-26T09:00:00.000002Z" },
      { id: "c", published_key: "2026-09-26T08:00:00.000001Z" },
    ];
    const page = await keysetPage({ kind: "creator", creatorId: "cr" }, { t: "2026-09-27T00:00:00Z", id: "zz" }, 2, null);
    expect(page.ids).toEqual(["a", "b"]);
    expect(page.next).toEqual({ t: "2026-09-26T09:00:00.000002Z", id: "b" });
    expect(calls[0].sql).not.toMatch(/OFFSET/i);
    expect(calls[0].sql).toContain("< ($2::timestamptz, $3::uuid)");
    expect(calls[0].params.at(-1)).toBe(3);
  });

  it("Following fără creatori urmăriți → gol, fără interogare", async () => {
    expect(await keysetPage({ kind: "following", creatorIds: [] }, null, 10, "u")).toEqual({ ids: [], next: null });
    expect(calls).toHaveLength(0);
  });
});
