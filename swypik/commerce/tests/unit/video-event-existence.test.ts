import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  interactable: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock("@/lib/video/interactable", () => ({
  isVideoInteractable: h.interactable,
}));
vi.mock("@/lib/db", () => ({ dbQuery: h.dbQuery }));
vi.mock("@/lib/social/session", () => ({
  getOptionalSocialUserId: async () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
  getClientIP: () => "203.0.113.10",
}));

import { POST } from "@/app/api/videos/[id]/event/route";

const VIDEO = "11111111-1111-4111-8111-111111111111";

function req(): Request {
  return new Request("https://swypik.com/api/videos/x/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_type: "impression", session_id: VIDEO }),
  });
}

beforeEach(() => {
  h.interactable.mockReset().mockResolvedValue(true);
  h.dbQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("video event target validation", () => {
  it("rejects malformed video ids before writes", async () => {
    const res = await POST(req() as never, { params: Promise.resolve({ id: "bad" }) });
    expect(res.status).toBe(400);
    expect(h.dbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for missing/hidden/non-interactable videos", async () => {
    h.interactable.mockResolvedValue(false);
    const res = await POST(req() as never, { params: Promise.resolve({ id: VIDEO }) });
    expect(res.status).toBe(404);
    expect(h.dbQuery).not.toHaveBeenCalled();
  });

  it("inserts only after the target passes the canonical gate", async () => {
    const res = await POST(req() as never, { params: Promise.resolve({ id: VIDEO }) });
    expect(res.status).toBe(200);
    expect(h.interactable).toHaveBeenCalledWith(VIDEO);
    expect(h.dbQuery).toHaveBeenCalledTimes(1);
    expect(String(h.dbQuery.mock.calls[0][0])).toContain("INSERT INTO user_watch_events");
  });
});
