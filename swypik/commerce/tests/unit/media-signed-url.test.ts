import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isServerMediaProxyAllowed,
  openMediaToken,
  sealMediaToken,
  signedMediaUrl,
} from "@/lib/media/signed-media";
import { openToken, resolveSignedKey } from "@/infra/cloudflare/media-worker/src/token";

const SECRET = "test-media-signing-secret";
const future = () => Math.floor(Date.now() / 1000) + 600;

beforeEach(() => {
  vi.stubEnv("MEDIA_SIGNING_SECRET", SECRET);
  vi.stubEnv("MEDIA_SIGNED_BASE_URL", "");
  vi.stubEnv("MEDIA_PUBLIC_BASE_URL", "https://media.example.test");
});
afterEach(() => vi.unstubAllEnvs());

function tokenOf(url: string): { token: string; rest: string } {
  const path = new URL(url).pathname;
  expect(path.startsWith("/s/")).toBe(true);
  const after = path.slice(3);
  const slash = after.indexOf("/");
  return { token: after.slice(0, slash), rest: after.slice(slash + 1) };
}

describe("lib/media/signed-media — token criptat (AES-256-GCM)", () => {
  it("seal/open: payload-ul revine intact; secret greșit, token modificat sau expirat → null", () => {
    const token = sealMediaToken({ prefix: "private/v/x/", expiresAt: future(), userId: "u1" }, SECRET);
    expect(openMediaToken(token, SECRET)).toMatchObject({ prefix: "private/v/x/", userId: "u1" });
    expect(openMediaToken(token, "other-secret")).toBeNull();
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    expect(openMediaToken(tampered, SECRET)).toBeNull();
    const expired = sealMediaToken({ prefix: "p/", expiresAt: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    expect(openMediaToken(expired, SECRET)).toBeNull();
    expect(openMediaToken("not-a-token", SECRET)).toBeNull();
  });

  it("token-ul nu dezvăluie cheia obiectului (nu e doar base64 de JSON)", () => {
    const token = sealMediaToken({ prefix: "music/raw/a/t/9f3c2b1a.m4a", expiresAt: future() }, SECRET);
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain("9f3c2b1a");
  });

  it("directory: URL pe CDN cu basename-ul relativ; Worker-ul îl decriptează și rezolvă cheia", async () => {
    const url = signedMediaUrl({ key: "private/videos/hls/v1/master.m3u8", scope: "directory", expiresAtMs: Date.now() + 60_000, userId: "u1" });
    expect(url).toMatch(/^https:\/\/media\.example\.test\/s\/[A-Za-z0-9_-]+\/master\.m3u8$/);
    const { token, rest } = tokenOf(url!);
    const payload = await openToken(token, SECRET);
    expect(payload).toMatchObject({ prefix: "private/videos/hls/v1/", userId: "u1" });
    expect(resolveSignedKey(payload!.prefix, rest)).toBe("private/videos/hls/v1/master.m3u8");
    // playlist-urile relative (720p/index.m3u8, seg.ts) rămân în același director semnat
    expect(resolveSignedKey(payload!.prefix, "720p/seg_001.ts")).toBe("private/videos/hls/v1/720p/seg_001.ts");
  });

  it("object: calea din URL e cosmetică; cheia reală vine doar din token", async () => {
    const url = signedMediaUrl({ key: "music/raw/a/t/secret.m4a", scope: "object", expiresAtMs: Date.now() + 60_000, displayName: "audio" });
    expect(url).not.toContain("secret");
    const { token, rest } = tokenOf(url!);
    expect(rest).toBe("audio");
    const payload = await openToken(token, SECRET);
    expect(resolveSignedKey(payload!.prefix, "orice")).toBe("music/raw/a/t/secret.m4a");
  });

  it("MEDIA_SIGNED_BASE_URL suprascrie originea; fără secret → null (fără semnare)", () => {
    vi.stubEnv("MEDIA_SIGNED_BASE_URL", "https://signed.example.test/");
    expect(signedMediaUrl({ key: "a/b.m4a", scope: "object", expiresAtMs: Date.now() + 1000 })).toMatch(/^https:\/\/signed\.example\.test\/s\//);
    vi.stubEnv("MEDIA_SIGNING_SECRET", "");
    expect(signedMediaUrl({ key: "a/b.m4a", scope: "object", expiresAtMs: Date.now() + 1000 })).toBeNull();
  });

  it("proxy-ul de bytes din app e oprit în producție (doar suprascriere explicită)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEDIA_SERVER_PROXY", "");
    expect(isServerMediaProxyAllowed()).toBe(false);
    vi.stubEnv("MEDIA_SERVER_PROXY", "1");
    expect(isServerMediaProxyAllowed()).toBe(true);
    vi.stubEnv("MEDIA_SERVER_PROXY", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(isServerMediaProxyAllowed()).toBe(true);
  });
});

describe("media-worker/token resolveSignedKey — fără ieșire din director", () => {
  it.each(["../x.ts", "a/../../x", "%2e%2e/x", "a//b", "a/%2Fb", "a/%5Cb", "./x", "%E0%A4%A"])("respinge %s", (rel) => {
    expect(resolveSignedKey("private/v/", rel)).toBeNull();
  });
  it("respinge prefix sau cale goală", () => {
    expect(resolveSignedKey("", "a")).toBeNull();
    expect(resolveSignedKey("private/v/", "")).toBeNull();
  });
});
