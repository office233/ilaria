import { describe, it, expect, beforeEach } from "vitest";
import { handleMediaRequest } from "@/infra/cloudflare/media-worker/src/handler";
import type { CacheLike, MediaWorkerEnv, R2BucketLike, R2GetOptionsLike, R2ObjectBodyLike } from "@/infra/cloudflare/media-worker/src/types";
import { sealMediaToken } from "@/lib/media/signed-media";

const SECRET = "worker-test-secret";
const ORIGIN = "https://app.example.test";
const HOST = "https://media.example.test";

function fakeObject(key: string, content: string, contentType: string, range?: { offset: number; length: number }): R2ObjectBodyLike {
  const bytes = new TextEncoder().encode(content);
  const slice = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
  return {
    key,
    size: bytes.length,
    httpEtag: `"etag-${key}"`,
    httpMetadata: { contentType },
    range,
    body: new Response(slice).body as ReadableStream,
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

class FakeBucket implements R2BucketLike {
  objects = new Map<string, { content: string; type: string }>();
  gets: string[] = [];
  async get(key: string, options?: R2GetOptionsLike) {
    this.gets.push(key);
    const o = this.objects.get(key);
    if (!o) return null;
    const m = options?.range?.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    const range = m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : undefined;
    return fakeObject(key, o.content, o.type, range);
  }
}

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  async match(req: Request) {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res);
  }
}

let bucket: FakeBucket;
let cache: FakeCache;
let pending: Promise<unknown>[];
let env: MediaWorkerEnv;
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

beforeEach(() => {
  bucket = new FakeBucket();
  bucket.objects.set("private/hls/ep1/master.m3u8", { content: "#EXTM3U\n720p/index.m3u8\n", type: "application/vnd.apple.mpegurl" });
  bucket.objects.set("private/hls/ep1/720p/seg_001.ts", { content: "SEGMENT-BYTES", type: "video/mp2t" });
  bucket.objects.set("private/hls/ep2/master.m3u8", { content: "#EXTM3U\n", type: "application/vnd.apple.mpegurl" });
  bucket.objects.set("music/raw/a/t/9f3c.m4a", { content: "0123456789", type: "audio/mp4" });
  bucket.objects.set("videos/hls/pub/master.m3u8", { content: "#EXTM3U\n", type: "application/vnd.apple.mpegurl" });
  cache = new FakeCache();
  pending = [];
  env = { MEDIA_BUCKET: bucket, MEDIA_SIGNING_SECRET: SECRET, ALLOWED_ORIGINS: `${ORIGIN}, https://www.app.example.test` };
});

const seal = (prefix: string, ttl = 600) => sealMediaToken({ prefix, expiresAt: Math.floor(Date.now() / 1000) + ttl, userId: "u1" }, SECRET);
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  handleMediaRequest(new Request(`${HOST}${path}`, { method, headers }), env, ctx, cache);

describe("media Worker — media privată servită direct din R2", () => {
  it("token de director: playlist + segmente relative, CORS pentru originea aplicației, cache privat în browser", async () => {
    const t = seal("private/hls/ep1/");
    const playlist = await get(`/s/${t}/master.m3u8`, { origin: ORIGIN });
    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toContain("720p/index.m3u8");
    expect(playlist.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(playlist.headers.get("cache-control")).toBe("private, max-age=60");

    const seg = await get(`/s/${t}/720p/seg_001.ts`);
    expect(seg.status).toBe(200);
    expect(await seg.text()).toBe("SEGMENT-BYTES");
    expect(seg.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("cheia de cache de la edge nu conține token-ul: alt cumpărător lovește același cache", async () => {
    await get(`/s/${seal("private/hls/ep1/")}/720p/seg_001.ts`);
    await Promise.all(pending);
    expect([...cache.store.keys()]).toEqual([`${HOST}/__media/private/hls/ep1/720p/seg_001.ts`]);
    const again = await get(`/s/${seal("private/hls/ep1/")}/720p/seg_001.ts`);
    expect(await again.text()).toBe("SEGMENT-BYTES");
    expect(bucket.gets).toEqual(["private/hls/ep1/720p/seg_001.ts"]);
  });

  it("refuză: token expirat, alt secret, traversare, alt director decât cel semnat", async () => {
    expect((await get(`/s/${seal("private/hls/ep1/", -5)}/master.m3u8`)).status).toBe(403);
    const foreign = sealMediaToken({ prefix: "private/hls/ep1/", expiresAt: Math.floor(Date.now() / 1000) + 60 }, "other");
    expect((await get(`/s/${foreign}/master.m3u8`)).status).toBe(403);
    expect((await get(`/s/${seal("private/hls/ep1/")}/..%2Fep2/master.m3u8`)).status).toBe(403);
    expect((await get(`/s/${seal("private/hls/ep1/")}/%2e%2e/ep2/master.m3u8`)).status).toBe(403);
    expect((await get(`/s/garbage/master.m3u8`)).status).toBe(403);
    expect((await get(`/s/${seal("private/hls/ep1/")}`)).status).toBe(403);
    expect(bucket.gets).toEqual([]);
  });

  it("acces direct la prefixul privat → 403; obiect public → servit cu cache lung/scurt", async () => {
    expect((await get("/private/hls/ep1/master.m3u8")).status).toBe(403);
    const pub = await get("/videos/hls/pub/master.m3u8");
    expect(pub.status).toBe(200);
    expect(pub.headers.get("cache-control")).toBe("public, max-age=60");
    expect((await get("/videos/missing.ts")).status).toBe(404);
  });

  it("token de obiect (piesă audio): Range → 206 direct din R2, fără Cache API", async () => {
    const res = await get(`/s/${seal("music/raw/a/t/9f3c.m4a")}/audio`, { range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
    await Promise.all(pending);
    expect(cache.store.size).toBe(0);
  });

  it("preflight CORS doar pentru originile permise; metode de scriere → 405", async () => {
    const ok = await get("/s/x/y", { origin: ORIGIN, "access-control-request-method": "GET" }, "OPTIONS");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toContain("Range");
    const other = await get("/s/x/y", { origin: "https://evil.example.test" }, "OPTIONS");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await get("/videos/a.ts", {}, "PUT")).status).toBe(405);
  });
});
