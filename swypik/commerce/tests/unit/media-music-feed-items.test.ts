import { describe, it, expect, vi, afterEach } from "vitest";
import { isCommercialLicense, isSecureStreamUrl } from "@/lib/audio/license";
import { isJamendoConfigured, mapJamendoTracks, getChillJamendoTracks } from "@/lib/audio/jamendo";
import { pollUntil } from "@/lib/media/poll";
import { unlockStatusFromRows } from "@/lib/movies/unlock-status";
import { clampFeedLimit } from "@/lib/media/feed-card";
import { toMovieFeedCard } from "@/lib/movies/feed-items";
import { toMusicFeedCard } from "@/lib/music/feed-items";
import type { MovieSeriesRow } from "@/lib/movies/types";
import type { TrackListItem } from "@/lib/music/repository";

describe("audio/license", () => {
  it("doar licențele comerciale care permit sincronizarea (fără NC/ND); necunoscut = nu", () => {
    expect(isCommercialLicense("swypik-artist")).toBe(true);
    expect(isCommercialLicense("http://creativecommons.org/licenses/by/3.0/")).toBe(true);
    expect(isCommercialLicense("https://creativecommons.org/licenses/by-sa/4.0/")).toBe(true);
    expect(isCommercialLicense("http://creativecommons.org/licenses/by-nc-sa/3.0/")).toBe(false);
    expect(isCommercialLicense("http://creativecommons.org/licenses/by-nd/3.0/")).toBe(false);
    expect(isCommercialLicense("all-rights-reserved")).toBe(false);
    expect(isCommercialLicense(null)).toBe(false);
  });
  it("stream-urile http sunt respinse (mixed content)", () => {
    expect(isSecureStreamUrl("https://live.example.ro/stream.aac")).toBe(true);
    expect(isSecureStreamUrl("http://live.example.ro/stream.aac")).toBe(false);
    expect(isSecureStreamUrl(undefined)).toBe(false);
  });
});

describe("audio/jamendo — doar cu cheie, doar licențe comerciale", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.JAMENDO_CLIENT_ID; });

  it("fără JAMENDO_CLIENT_ID: neconfigurat, zero rețea, zero piese (nu există ID public de rezervă)", async () => {
    delete process.env.JAMENDO_CLIENT_ID;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(isJamendoConfigured()).toBe(false);
    expect(await getChillJamendoTracks(5)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mapare: exclude NC și http; marchează licensedForCommercial", () => {
    const items = mapJamendoTracks([
      { id: "1", name: "BY", duration: 100, artist_name: "A", audio: "https://j.test/1.mp3", license_ccurl: "http://creativecommons.org/licenses/by/3.0/" },
      { id: "2", name: "NC", duration: 100, artist_name: "B", audio: "https://j.test/2.mp3", license_ccurl: "http://creativecommons.org/licenses/by-nc/3.0/" },
      { id: "3", name: "HTTP", duration: 100, artist_name: "C", audio: "http://j.test/3.mp3", license_ccurl: "http://creativecommons.org/licenses/by/3.0/" },
    ], "Chill", false);
    expect(items.map((i) => i.title)).toEqual(["BY"]);
    expect(items[0].licensedForCommercial).toBe(true);
  });
});

describe("media/poll + movies/unlock-status (cursa după plată)", () => {
  it("așteaptă până când deblocarea e `paid`, ignoră erorile trecătoare", async () => {
    const seq = ["pending", "boom", "paid"];
    let i = 0;
    const r = await pollUntil(
      async () => { const s = seq[i++]; if (s === "boom") throw new Error("net"); return s; },
      (s) => s === "paid",
      { attempts: 5, intervalMs: 0, sleep: async () => undefined },
    );
    expect(r).toBe("paid");
  });
  it("renunță după numărul maxim de încercări (null)", async () => {
    const r = await pollUntil(async () => "pending", (s) => s === "paid", { attempts: 3, intervalMs: 0, sleep: async () => undefined });
    expect(r).toBeNull();
  });
  it("sezonul plătit acoperă episodul; pending doar pentru ținta cerută", () => {
    expect(unlockStatusFromRows([{ episode_id: null, status: "paid" }], "e1")).toBe("paid");
    expect(unlockStatusFromRows([{ episode_id: "e1", status: "pending" }], "e1")).toBe("pending");
    expect(unlockStatusFromRows([{ episode_id: "e2", status: "paid" }], "e1")).toBe("none");
  });
});

describe("feed-items (Movies/Music) — carduri normalizate", () => {
  it("clampFeedLimit", () => {
    expect(clampFeedLimit(undefined)).toBe(10);
    expect(clampFeedLimit(0)).toBe(1);
    expect(clampFeedLimit(1000)).toBe(50);
  });

  it("titlu Movies: href, imagine, clip doar dacă ep. 1 e gratuit, atribuire CC BY", () => {
    const s = {
      id: "s1", slug: "sintel-x", title: "Sintel", poster_url: "https://img/p.jpg", cover_url: null, genres: ["drama"],
      free_episodes: 1, license_type: "cc_by", attribution_text: "© Blender Foundation", published_at: "2026-09-26", owner_name: "Swypik",
    } as unknown as MovieSeriesRow & { owner_name: string | null };
    const card = toMovieFeedCard(s, "vid-1");
    expect(card).toMatchObject({ kind: "movie_title", id: "s1", href: "/movies/sintel-x", image: "https://img/p.jpg", isFree: true, attribution: "© Blender Foundation", licensedForCommercial: true });
    expect(card.media).toEqual({ type: "video", videoId: "vid-1" });
    expect(toMovieFeedCard(s, null).media).toBeNull();
  });

  it("piesă Music: doar gratuite, publicate, publice, audiență generală", () => {
    const t = {
      id: "t1", slug: "song", title: "Song", status: "published", is_premium: false, public_url: "https://cdn/x.m4a", audience: "general",
      cover_url: null, genre: "pop", duration_ms: 180000, published_at: null,
      artist: { stage_name: "Ana", cover_url: "https://img/a.jpg", avatar_url: null },
    } as unknown as TrackListItem;
    expect(toMusicFeedCard(t)).toMatchObject({ kind: "music_track", href: "/music/track/song", subtitle: "Ana", image: "https://img/a.jpg", licensedForCommercial: true });
    expect(toMusicFeedCard({ ...t, is_premium: true } as TrackListItem)).toBeNull();
    expect(toMusicFeedCard({ ...t, audience: "kids" } as TrackListItem)).toBeNull();
    expect(toMusicFeedCard({ ...t, public_url: null } as TrackListItem)).toBeNull();
  });
});
