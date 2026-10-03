import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/live/streams/[id]/poll/route";

/**
 * Audit 2026-09-24 (wave2-misc): /api/live/streams/[id]/poll could create
 * `live_polls` rows, but nothing in the app can vote on or display a poll —
 * a dead half-feature reachable by anyone with a stream. Both handlers now
 * fail closed with 404 `not_available` instead of writing rows nobody will
 * ever see.
 */
describe("GET/POST /api/live/streams/[id]/poll — disabled dead feature", () => {
  const params = Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" });

  it("POST returns 404 not_available without touching auth/db", async () => {
    const req = new NextRequest("http://localhost/api/live/streams/x/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "q", options: ["a", "b"] }),
    });
    const res = await POST(req, { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_available" });
  });

  it("GET returns 404 not_available", async () => {
    const req = new NextRequest("http://localhost/api/live/streams/x/poll");
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_available" });
  });
});
