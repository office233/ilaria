import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

let isAdmin = true;
const created: unknown[] = [];
const imported: unknown[] = [];

vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response("frozen", { status: 410 }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 10 }), getClientIP: () => "127.0.0.1" }));
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: async () => undefined }));
vi.mock("@/lib/auth/getAuthUser", () => ({
  requireAuth: async () => (isAdmin ? { userId: "admin-1", isAdmin: true, role: "admin" } : NextResponse.json({ error: "Forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/movies/repository", () => ({ listSeriesForAdmin: async () => [] }));
vi.mock("@/lib/movies/admin-repository", () => ({
  createIngestedTitle: async (input: { title: string }, slug: string) => {
    created.push(input);
    return { id: "s1", slug, title: input.title, license_type: "cc_by", license_source_url: null };
  },
}));
vi.mock("@/lib/movies/ingest-media", () => ({
  importEpisodeFromUrl: async (args: unknown) => {
    imported.push(args);
    return { episode: { id: "e1" }, videoId: "v1", queued: true };
  },
}));

import { POST } from "@/app/api/admin/movies/route";

const post = (body: unknown) => POST(new Request("https://swypik.test/api/admin/movies", { method: "POST", body: JSON.stringify(body) }));
const valid = {
  title: "Big Buck Bunny",
  license: { type: "cc_by", attributionText: "© Blender Foundation | peach.blender.org — CC BY 3.0", sourceUrl: "https://peach.blender.org/", territories: ["WORLD"] },
};

beforeEach(() => {
  isAdmin = true;
  created.length = 0;
  imported.length = 0;
});

describe("POST /api/admin/movies — ingest licențiat", () => {
  it("doar admin", async () => {
    isAdmin = false;
    expect((await post(valid)).status).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("fără licență → 400, nimic creat", async () => {
    const res = await post({ title: "X" });
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("titlu valid → 201 ca ciornă, fără blocaje; fără fișier nu pornește importul", async () => {
    const res = await post(valid);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.publishBlockers).toEqual([]);
    expect(body.episode).toBeNull();
    expect(imported).toHaveLength(0);
  });

  it("cu mediaUrl https → episodul 1 intră în pipeline; blocajele de licență sunt raportate", async () => {
    const res = await post({ ...valid, mediaUrl: "https://download.example.org/bbb.mp4", license: { type: "cc_by", territories: ["WORLD"] } });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(imported).toHaveLength(1);
    expect(body.queued).toBe(true);
    expect(body.publishBlockers).toEqual(["attribution_required", "source_url_required"]);
  });
});
