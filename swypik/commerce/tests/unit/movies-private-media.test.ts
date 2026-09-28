import { beforeEach, describe, expect, it, vi } from "vitest";

// P0 (audit 2): media episoadelor plătite nu are voie să fie accesibilă din date publice.
const BASE = "https://media.example.test";
process.env.S3_ENDPOINT = "https://s3.example.test";
process.env.S3_BUCKET = "swypik-media";
process.env.S3_ACCESS_KEY = "k";
process.env.S3_SECRET_KEY = "s";
process.env.MEDIA_PUBLIC_BASE_URL = BASE;
process.env.MEDIA_PRIVATE_PREFIX = "private/";

// ── bucket S3 în memorie ──
const bucket = new Map<string, string>();
const s3 = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        const input = cmd.input;
        if (name === "ListObjectsV2Command") {
            const prefix = String(input.Prefix);
            return { Contents: [...bucket.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })), IsTruncated: false };
        }
        if (name === "CopyObjectCommand") {
            const from = decodeURI(String(input.CopySource)).replace(/^swypik-media\//, "");
            if (!bucket.has(from)) throw new Error("NoSuchKey");
            bucket.set(String(input.Key), bucket.get(from)!);
            return {};
        }
        if (name === "DeleteObjectsCommand") {
            for (const o of (input.Delete as { Objects: { Key: string }[] }).Objects) bucket.delete(o.Key);
            return {};
        }
        throw new Error(`unexpected ${name}`);
    }),
};
vi.mock("@/lib/storage/s3-client", () => ({ getS3Client: () => s3, getStorageBucket: () => "swypik-media" }));

// ── DB în memorie: un singur video ──
type Video = { id: string; playback_url: string | null; thumbnail_url: string | null };
let video: Video;
vi.mock("@/lib/db", () => ({
    withAdvisoryLock: async (_k: string, fn: () => Promise<unknown>) => fn(),
    withTransaction: vi.fn(),
    dbQuery: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM videos WHERE id = $1")) return { rows: [video], rowCount: 1 };
        if (sql.includes("UPDATE videos") && sql.includes("playback_url = $2")) {
            if (video.playback_url !== params[3]) return { rows: [], rowCount: 0 };
            Object.assign(video, { playback_url: params[1], thumbnail_url: params[2] });
            return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE videos SET thumbnail_url")) {
            video.thumbnail_url = params[1] as string;
            return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ensureEpisodeMediaPrivate } from "@/lib/movies/private-media";
import { privateJobPayload } from "@/lib/movies/private-ingest";
import { newPrivateMediaDir } from "@/lib/media/private-media";
import { publicEpisodeThumbnail, toEpisodeDtos, toSeriesDto } from "@/lib/movies/dto";
import { targetVisibility } from "@/lib/movies/visibility";
import type { MovieEpisodeWithThumb, MovieSeriesRow } from "@/lib/movies/types";

const VIDEO_ID = "11111111-2222-4333-8444-555555555555";
const HLS = `videos/hls/${VIDEO_ID}`;

beforeEach(() => {
    bucket.clear();
    for (const f of ["master.m3u8", "720p/index.m3u8", "720p/seg_000.ts", "thumbnail.jpg", "preview.mp4"]) bucket.set(`${HLS}/${f}`, f);
    video = { id: VIDEO_ID, playback_url: `${BASE}/${HLS}/master.m3u8`, thumbnail_url: `${BASE}/${HLS}/thumbnail.jpg` };
});

const series = {
    id: "s1", slug: "s", title: "T", synopsis: "", genres: [], cover_url: null, poster_url: null, trailer_video_id: null,
    free_episodes: 1, episode_price_cents: 500, is_adult: false, owner_user_id: "owner", status: "published",
} as unknown as MovieSeriesRow;
const paidEpisode = (thumb: string | null) =>
    ({ id: "e2", series_id: "s1", episode_number: 2, video_id: VIDEO_ID, title: "Ep 2", duration_ms: 1000, status: "published", thumbnail_url: thumb }) as unknown as MovieEpisodeWithThumb;
const anonymous = { userId: null, isAdmin: false, hasSeasonUnlock: false, unlockedEpisodeIds: new Set<string>() };

describe("ensureEpisodeMediaPrivate", () => {
    it("moves the whole HLS directory into a random private dir, then deletes the public copies", async () => {
        await expect(ensureEpisodeMediaPrivate(VIDEO_ID)).resolves.toBe("moved");
        expect(video.playback_url).toMatch(new RegExp(`^${BASE}/private/movies/[0-9a-f]{32}/master\\.m3u8$`));
        expect([...bucket.keys()].some((k) => k.startsWith("videos/hls/"))).toBe(false);
        const dir = video.playback_url!.slice(BASE.length + 1).replace("master.m3u8", "");
        expect(bucket.has(`${dir}720p/seg_000.ts`)).toBe(true);
        // Thumbnail-ul e public, dar la o cheie aleatoare fără legătură cu directorul privat.
        expect(video.thumbnail_url).toMatch(new RegExp(`^${BASE}/movies/thumbs/[0-9a-f]{32}\\.jpg$`));
        expect(bucket.has(video.thumbnail_url!.slice(BASE.length + 1))).toBe(true);
    });

    it("is idempotent: a second run changes nothing", async () => {
        await ensureEpisodeMediaPrivate(VIDEO_ID);
        const snapshot = { ...video };
        const keys = [...bucket.keys()].sort();
        await expect(ensureEpisodeMediaPrivate(VIDEO_ID)).resolves.toBe("already");
        expect(video).toEqual(snapshot);
        expect([...bucket.keys()].sort()).toEqual(keys);
    });

    it("pulls a worker-written thumbnail out of a directly-ingested private dir", async () => {
        bucket.clear();
        const dir = "private/movies/0123456789abcdef0123456789abcdef";
        bucket.set(`${dir}/master.m3u8`, "m");
        bucket.set(`${dir}/thumbnail.jpg`, "t");
        video = { id: VIDEO_ID, playback_url: `${BASE}/${dir}/master.m3u8`, thumbnail_url: `${BASE}/${dir}/thumbnail.jpg` };
        await expect(ensureEpisodeMediaPrivate(VIDEO_ID)).resolves.toBe("thumb_fixed");
        expect(video.thumbnail_url).not.toContain(dir);
        expect(video.playback_url).toBe(`${BASE}/${dir}/master.m3u8`);
    });
});

describe("a paid master.m3u8 URL is not derivable from public data", () => {
    it("nothing public (DTOs, thumbnail, video id) contains the private directory", async () => {
        await ensureEpisodeMediaPrivate(VIDEO_ID);
        const privateDir = video.playback_url!.split("/private/movies/")[1].split("/")[0];
        const publicData = JSON.stringify({
            series: toSeriesDto(series, 2, "Owner"),
            episodes: toEpisodeDtos(series, [paidEpisode(video.thumbnail_url)], anonymous, []),
        });
        expect(publicData).not.toContain(privateDir);
        expect(publicData).not.toContain("master.m3u8");
        expect(publicData).not.toContain(VIDEO_ID);
        // Id-ul videoului nu ajută: directorul e aleator, nu derivat din id.
        expect(video.playback_url).not.toContain(VIDEO_ID);
        // Iar thumbnail-ul are propriul segment aleator.
        expect(video.thumbnail_url).not.toContain(privateDir);
    });

    it("a paid episode never exposes a thumbnail from its HLS folder or the private prefix", () => {
        expect(publicEpisodeThumbnail(`${BASE}/${HLS}/thumbnail.jpg`, true)).toBeNull();
        expect(publicEpisodeThumbnail(`${BASE}/private/movies/abc/thumbnail.jpg`, false)).toBeNull();
        expect(publicEpisodeThumbnail(`${BASE}/${HLS}/thumbnail.jpg`, false)).toBe(`${BASE}/${HLS}/thumbnail.jpg`);
        const [dto] = toEpisodeDtos(series, [paidEpisode(`${BASE}/${HLS}/thumbnail.jpg`)], anonymous, []);
        expect(dto).toMatchObject({ locked: true, thumbnailUrl: null });
    });

    it("direct paid ingest: every worker output key lands in a random private dir", () => {
        const dir = newPrivateMediaDir("movies");
        const payload = privateJobPayload(
            { output_prefix: `videos/hls/${VIDEO_ID}`, thumbnail_key: "x", preview_key: "y", hls_master_key: "z", video_id: VIDEO_ID } as never,
            dir,
        );
        expect(payload.output_prefix).toMatch(/^private\/movies\/[0-9a-f]{32}$/);
        for (const k of [payload.hls_master_key, payload.thumbnail_key, payload.preview_key]) {
            expect(k.startsWith(`${payload.output_prefix}/`)).toBe(true);
            expect(k).not.toContain(VIDEO_ID);
        }
        expect(newPrivateMediaDir("movies")).not.toBe(dir);
    });

    it("an episode whose media is private never becomes public in the feed", () => {
        expect(targetVisibility({ free_episodes: 3, status: "published" }, { episode_number: 1, status: "published", media_private: true })).toBe("private");
    });
});
