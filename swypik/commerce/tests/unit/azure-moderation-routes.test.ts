import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/** Maparea moderării AI pe fluxurile existente: avatar, copertă video, poze produs, gate-ul de publicare. */

const s = vi.hoisted(() => ({
  image: { decision: "allow", reasons: [] as string[] } as { decision: string; reasons: string[] },
  text: { flagged: false, reasons: [] as string[], decision: "allow", maxSeverity: 0 },
  sql: [] as Array<{ sql: string; params: unknown[] }>,
  rows: (_sql: string): unknown[] => [],
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    s.sql.push({ sql, params });
    return { rows: s.rows(sql), rowCount: 1 };
  }),
}));
vi.mock("@/lib/moderation/ai-image", () => ({
  moderateImage: vi.fn(async () => s.image),
  needsReview: (m: { decision: string }) => m.decision === "review" || m.decision === "unavailable",
}));
vi.mock("@/lib/ai/moderate", () => ({ moderate: vi.fn(async () => s.text) }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => ({ userId: "11111111-1111-4111-8111-111111111111" }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/storage/upload", () => ({
  MAX_FILE_SIZE: 5 * 1024 * 1024,
  isStorageConfigured: () => true,
  uploadFile: vi.fn(async () => ({ url: "https://cdn.example/a.webp", key: "a", size: 1 })),
}));
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => "seller-1" }));
vi.mock("@/lib/moderation/labelVideo", () => ({ labelVideo: vi.fn(async () => undefined) }));
vi.mock("@/lib/moderation/strikes", () => ({ recordStrike: vi.fn(async () => undefined) }));

import { POST as avatarPOST } from "@/app/api/users/me/avatar/route";
import { POST as productImagePOST } from "@/app/api/seller/products/upload-image/route";
import { moderateOnPublish } from "@/lib/video/moderation-gate";
import { holdVideoForImageReview } from "@/lib/moderation/video-image";

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
}

async function avatarRequest(): Promise<Request> {
  const fd = new FormData();
  fd.append("avatar", new File([new Uint8Array(await png())], "a.png", { type: "image/png" }));
  return new Request("http://l/api/users/me/avatar", { method: "POST", body: fd });
}

beforeEach(() => {
  s.image = { decision: "allow", reasons: [] };
  s.text = { flagged: false, reasons: [], decision: "allow", maxSeverity: 0 };
  s.sql = [];
  s.rows = () => [];
});

describe("avatar", () => {
  it("block → 422 avatar_rejected, nothing saved", async () => {
    s.image = { decision: "block", reasons: ["sexual:6"] };
    const res = await avatarPOST(await avatarRequest());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "avatar_rejected" });
    expect(s.sql).toHaveLength(0);
  });

  it("review → saved + moderation case on the user (image_ai)", async () => {
    s.image = { decision: "review", reasons: ["sexual:2"] };
    const res = await avatarPOST(await avatarRequest());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const insert = s.sql.find((q) => q.sql.includes("INSERT INTO moderation_cases"));
    expect(insert?.sql).toContain("target_user_id");
    expect(JSON.parse(String(insert?.params[2]))).toMatchObject({ source: "image_ai", reasons: ["sexual:2"], kind: "avatar" });
  });
});

describe("seller product image", () => {
  it("block → 422 image_rejected", async () => {
    s.image = { decision: "block", reasons: ["violence:6"] };
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(await png())]));
    const res = await productImagePOST(new Request("http://l/x", { method: "POST", body: fd }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ success: false, code: "image_rejected" });
  });
});

describe("video publish gate + image cases", () => {
  const input = { videoId: "v1", creatorId: "c1", currentStatus: "pending_review", title: "Clip frumos", description: "", tags: [] };

  it("holds the clip for review while an image_ai case is open", async () => {
    s.rows = (sql) => (sql.includes("metadata->>'source' = 'image_ai'") ? [{ ok: true }] : []);
    expect(await moderateOnPublish(input)).toBe("pending_review");
  });

  it("approves clean text with no image case (auto mode)", async () => {
    expect(await moderateOnPublish(input)).toBe("approved");
  });

  it("Content Safety unavailable → pending_review with a case", async () => {
    s.text = { flagged: true, reasons: ["moderation_unavailable"], decision: "unavailable", maxSeverity: 0 };
    expect(await moderateOnPublish(input)).toBe("pending_review");
    const insert = s.sql.find((q) => q.sql.includes("INSERT INTO moderation_cases"));
    expect(String(insert?.params[1])).toContain("moderation_unavailable");
  });

  it("holdVideoForImageReview opens a case and demotes an approved clip", async () => {
    await holdVideoForImageReview("v1", { decision: "unavailable", reasons: ["moderation_unavailable"] }, { kind: "cover" });
    expect(s.sql[0].sql).toContain("target_video_id");
    expect(s.sql[0].params[1]).toBe("low");
    expect(s.sql[1].sql).toContain("moderation_status = 'pending_review'");
    expect(s.sql[1].sql).toContain("moderation_status = 'approved'");
  });
});
