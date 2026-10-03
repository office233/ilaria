/** Audit 2 upload: Content-Length semnat pe părți (P2-13), `next` fără `?` gol (P2-23), audioTrackId validat (P2-8). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/storage/video-storage", () => ({
  getVideoStorageBucket: () => "media",
  isVideoStorageConfigured: () => true,
  buildRawVideoObjectKey: () => "videos/raw/k.mp4",
  getS3Client: () => new S3Client({ region: "auto", endpoint: "https://r2.example.test", credentials: { accessKeyId: "a", secretAccessKey: "b" }, forcePathStyle: true }),
  getPresignClient: () => new S3Client({ region: "auto", endpoint: "https://r2.example.test", credentials: { accessKeyId: "a", secretAccessKey: "b" }, forcePathStyle: true }),
}));

const auth = vi.hoisted(() => ({ role: "guest" as string, userId: null as string | null }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => auth }));
const nav = vi.hoisted(() => ({ nextRedirect: vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`); }) }));
vi.mock("next/navigation", () => ({ redirect: nav.nextRedirect, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/i18n/navigation", () => ({
  getPathname: ({ href, locale }: { href: string | { pathname: string; query: Record<string, string> }; locale: string }) => {
    const prefix = locale === "ro" ? "" : `/${locale}`;
    if (typeof href === "string") return `${prefix}${href}`;
    return `${prefix}${href.pathname}?${new URLSearchParams(href.query).toString()}`;
  },
  redirect: vi.fn(),
}));

let userId: string | null = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
vi.mock("@/lib/creator/session", () => ({ getCreatorUserId: async () => userId, getUserRole: async () => "creator" }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true }) }));
const created = vi.hoisted(() => ({ create: vi.fn(async () => ({ sessionId: "s", videoId: "v", partSize: 1, totalParts: 1, expiresAt: "x" })) }));
vi.mock("@/lib/video/upload/create-session", () => ({ createUploadSession: created.create }));

let trackOk = false;
vi.mock("@/lib/db", () => ({
  dbQuery: async (sql: string) => (sql.includes("FROM audio_tracks") ? { rows: [{ ok: trackOk }] } : { rows: [] }),
  getDb: () => ({}),
}));

import { expectedPartSize, signUploadParts } from "@/lib/video/storage-multipart";
import { guardCreatePage } from "@/components/upload/createPageGuard";
import { POST as createSession } from "@/app/api/creator/upload-session/route";

beforeEach(() => {
  created.create.mockClear();
  nav.nextRedirect.mockClear();
  trackOk = false;
});

describe("părți multipart cu Content-Length semnat", () => {
  it("mărimea așteptată: părți pline, ultima parțială, dincolo de fișier → null", () => {
    expect(expectedPartSize(1, 8, 20)).toBe(8);
    expect(expectedPartSize(3, 8, 20)).toBe(4);
    expect(expectedPartSize(4, 8, 20)).toBeNull();
    expect(expectedPartSize(1, 8, 0)).toBeNull();
  });

  it("URL-ul presemnat include content-length în SignedHeaders", async () => {
    const [part] = await signUploadParts("videos/raw/k.mp4", "up-1", [3], { partSize: 8, byteSize: 20 });
    const url = new URL(part.url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    const [legacy] = await signUploadParts("videos/raw/k.mp4", "up-1", [1]);
    expect(new URL(legacy.url).searchParams.get("X-Amz-SignedHeaders")).not.toContain("content-length");
  });
});

describe("poarta paginilor de creare", () => {
  it("fără parametri → next fără `?` gol; cu parametri → păstrați", async () => {
    await expect(guardCreatePage("ro", "/upload", { draft: undefined, audio: "" })).rejects.toThrow("REDIRECT /auth/login?next=%2Fupload");
    await expect(guardCreatePage("en", "/upload", { audio: "5" })).rejects.toThrow(
      `REDIRECT /auth/login?next=${encodeURIComponent("/en/upload?audio=5")}`,
    );
  });
});

describe("POST /api/creator/upload-session cu audioTrackId", () => {
  const body = (extra: Record<string, unknown>) =>
    new Request("http://l/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 1000, ...extra }),
    });

  it("piesă nelicențiată/inexistentă → 422 invalid_audio_track, fără sesiune", async () => {
    const res = await createSession(body({ audioTrackId: 42 }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_audio_track");
    expect(created.create).not.toHaveBeenCalled();
  });

  it("piesă licențiată → sesiunea se creează", async () => {
    trackOk = true;
    expect((await createSession(body({ audioTrackId: 42 }))).status).toBe(201);
    expect((await createSession(body({}))).status).toBe(201);
  });
});
