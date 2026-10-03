import { describe, it, expect } from "vitest";
import { audioTrackRowFor } from "@/lib/music/publish";

const artist = { user_id: "a1", stage_name: "Zara", slug: "zara", bio: "", avatar_url: "https://cdn/a.jpg", cover_url: null, approved_at: "", created_at: "", updated_at: "" };
const base = { id: "t1", title: "Vara", genre: "pop", duration_ms: 183_400, public_url: "https://cdn/music/t1.m4a", cover_url: "https://cdn/c.jpg", is_premium: false, allow_reels: true };

describe("music/publish", () => {
  it("piesa gratuită cu allow_reels devine sunet: source swypik_music, durata în secunde rotunjită, licență artist", () => {
    expect(audioTrackRowFor(base, artist)).toEqual({
      source: "swypik_music",
      source_id: "t1",
      title: "Vara",
      artist: "Zara",
      duration_s: 183,
      audio_url: "https://cdn/music/t1.m4a",
      preview_url: null,
      image_url: "https://cdn/c.jpg",
      genre: "pop",
      license: "swypik-artist",
      attribution_url: "/music/artist/zara",
      is_active: true,
    });
  });
  it("premium, fără allow_reels sau fără URL public ⇒ niciun sunet public", () => {
    expect(audioTrackRowFor({ ...base, is_premium: true }, artist)).toBeNull();
    expect(audioTrackRowFor({ ...base, allow_reels: false }, artist)).toBeNull();
    expect(audioTrackRowFor({ ...base, public_url: null }, artist)).toBeNull();
  });
  it("durata se rotunjește la secunde, minimum 1 (audio_tracks.duration_s > 0)", () => {
    expect(audioTrackRowFor({ ...base, duration_ms: 400 }, artist)?.duration_s).toBe(1);
  });
});

describe("music/slug", () => {
  it("kebab-case ASCII din titlu + sufix unic; fallback pe prefix cand titlul nu are litere", async () => {
    const { slugifyMusic } = await import("@/lib/music/slug");
    expect(slugifyMusic("Vara Asta - Remix!", "track")).toMatch(/^vara-asta-remix-[a-z0-9]+$/);
    expect(slugifyMusic("???", "album")).toMatch(/^album-[a-z0-9]+$/);
  });
});
