import { describe, it, expect, vi, afterEach } from "vitest";

const track = {
  id: "trk-1",
  slug: "song",
  artist_user_id: "artist",
  status: "published",
  is_premium: true,
  album_id: null,
  price_cents: 300,
  object_key: "music/raw/artist/trk-1/5e2f9a.m4a",
  public_url: null as string | null,
};

vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response("frozen", { status: 410 }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 10 }), getClientIP: () => "127.0.0.1" }));
vi.mock("@/lib/music/repository", () => ({
  getTrackBySlug: async () => track,
  getAlbumById: async () => null,
  listAlbumTracks: async () => [],
}));
vi.mock("@/lib/music/viewer", () => ({ buildMusicViewer: async () => ({}) }));
vi.mock("@/lib/music/access", () => ({ canStream: () => true }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => ({ userId: "fan-1", isAdmin: false }) }));

import { GET } from "@/app/api/music/tracks/[slug]/play/route";
import { openMediaToken } from "@/lib/media/signed-media";

const call = () => GET(new Request("https://swypik.test/api/music/tracks/song/play"), { params: Promise.resolve({ slug: "song" }) });
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/music/tracks/[slug]/play — piesă premium", () => {
  it("producție cu semnare: URL pe CDN, basename-ul real nu apare, token legat de user", async () => {
    vi.stubEnv("MEDIA_SIGNING_SECRET", "music-secret");
    vi.stubEnv("MEDIA_PUBLIC_BASE_URL", "https://media.example.test");
    const body = await (await call()).json();
    expect(body.url).toMatch(/^https:\/\/media\.example\.test\/s\/[A-Za-z0-9_-]+\/audio$/);
    expect(body.url).not.toContain("5e2f9a");
    const token = new URL(body.url).pathname.split("/")[2];
    expect(openMediaToken(token, "music-secret")).toMatchObject({ prefix: track.object_key, userId: "fan-1" });
  });

  it("dezvoltare fără semnare → proxy-ul local cu segment constant", async () => {
    vi.stubEnv("MEDIA_SIGNING_SECRET", "");
    const body = await (await call()).json();
    expect(body.url).toMatch(/^\/api\/music\/stream\/[^/]+\/audio$/);
  });

  it("producție fără semnare → 503 (niciun byte prin server)", async () => {
    vi.stubEnv("MEDIA_SIGNING_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEDIA_SERVER_PROXY", "");
    const res = await call();
    expect(res.status).toBe(503);
  });
});
