import { describe, it, expect } from "vitest";
import { signStreamToken, verifyStreamToken } from "@/lib/media/stream-token";
import { rewriteHlsPlaylist } from "@/lib/media/hls-rewrite";

const SECRET = "test-secret-please-ignore";

describe("movies/stream-token", () => {
  const payload = { userId: "u1", scope: "movies" as const, mediaId: "e1", expiresAt: 1_800_000_000_000 };
  it("semnătura se verifică și întoarce payload-ul", () => {
    const token = signStreamToken(payload, SECRET);
    expect(verifyStreamToken(token, SECRET, payload.expiresAt - 1000)).toEqual(payload);
  });
  it("respinge token expirat, secret greșit, payload modificat, format invalid", () => {
    const token = signStreamToken(payload, SECRET);
    expect(verifyStreamToken(token, SECRET, payload.expiresAt + 1)).toBeNull();
    expect(verifyStreamToken(token, "other", payload.expiresAt - 1000)).toBeNull();
    const [body, sig] = token.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...payload, mediaId: "e2" })).toString("base64url");
    expect(verifyStreamToken(`${tampered}.${sig}`, SECRET, 0)).toBeNull();
    expect(verifyStreamToken(`${body}`, SECRET, 0)).toBeNull();
    expect(verifyStreamToken("garbage", SECRET, 0)).toBeNull();
  });
  it("respinge un scope necunoscut (token-urile Movies si Music nu sunt interschimbabile)", () => {
    const foreign = signStreamToken({ ...payload, scope: "other" as unknown as "movies" }, SECRET);
    expect(verifyStreamToken(foreign, SECRET, 0)).toBeNull();
  });
});

describe("movies/hls-rewrite", () => {
  const base = "https://media.example.com/videos/hls/abc/index.m3u8";
  const toProxy = (u: string) => `/api/movies/stream/T?p=${encodeURIComponent(u)}`;
  it("rescrie liniile de URI (relative și absolute), lasă tag-urile și comentariile", () => {
    const input = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXTINF:4.0,", "seg0.ts", "#EXTINF:4.0,", "https://media.example.com/videos/hls/abc/seg1.ts", "", "#EXT-X-ENDLIST"].join("\n");
    const out = rewriteHlsPlaylist(input, base, toProxy);
    const lines = out.split("\n");
    expect(lines[3]).toBe(toProxy("https://media.example.com/videos/hls/abc/seg0.ts"));
    expect(lines[5]).toBe(toProxy("https://media.example.com/videos/hls/abc/seg1.ts"));
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[7]).toBe("#EXT-X-ENDLIST");
  });
  it("rescrie și URI-urile din atributele tag-urilor (chei AES, media alternative)", () => {
    const input = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/a.m3u8"';
    const out = rewriteHlsPlaylist(input, base, toProxy);
    expect(out).toContain(`URI="${toProxy("https://media.example.com/videos/hls/abc/key.bin")}"`);
    expect(out).toContain(`URI="${toProxy("https://media.example.com/videos/hls/abc/audio/a.m3u8")}"`);
  });
});
