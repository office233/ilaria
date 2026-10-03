import { describe, expect, it } from "vitest";
import * as v1CatchAll from "@/app/api/v1/[...path]/route";

type HandlerContext = { params: Promise<{ path: string[] }> };

function ctx(...path: string[]): HandlerContext {
  return { params: Promise.resolve({ path }) };
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost/api/v1/${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/v1 catch-all security boundary", () => {
  it("fails closed for arbitrary GET paths", async () => {
    const res = await v1CatchAll.GET(request("videos/abc/comments"), ctx("videos", "abc", "comments"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails closed for arbitrary mutations even when the body supplies an identity", async () => {
    const res = await v1CatchAll.POST(
      request("social/like", "POST", { user_id: "victim", video_id: "video-1" }),
      ctx("social", "like"),
    );
    expect(res.status).toBe(404);
  });

  it("never exposes admin paths", async () => {
    const res = await v1CatchAll.GET(request("admin/moderation/cases"), ctx("admin", "moderation", "cases"));
    expect(res.status).toBe(404);
  });

  it("keeps the retired checkout contract", async () => {
    const res = await v1CatchAll.POST(request("checkout", "POST", { items: [] }), ctx("checkout"));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      code: "legacy_checkout_retired",
      replacement: "/api/checkout/create-intent",
    });
  });

  it("keeps the notification compatibility fallback local and empty", async () => {
    const res = await v1CatchAll.GET(request("notifications"), ctx("notifications"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notifications: [], unread: 0, source: "next-fallback" });
  });
});
