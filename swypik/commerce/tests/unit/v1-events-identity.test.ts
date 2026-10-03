import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  resolveIdentity: vi.fn(),
  getSocialApiBaseUrl: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: h.rateLimit,
  getClientIP: () => "203.0.113.10",
}));
vi.mock("@/lib/events/platform-identity", () => ({
  resolvePlatformEventIdentity: h.resolveIdentity,
}));
vi.mock("@/lib/social/proxy", () => ({
  getSocialApiBaseUrl: h.getSocialApiBaseUrl,
}));

import { POST as postOne } from "@/app/api/v1/events/route";
import { POST as postBatch } from "@/app/api/v1/events/batch/route";

const VIDEO = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.rateLimit.mockReset().mockResolvedValue({ success: true, remaining: 10 });
  h.resolveIdentity.mockReset().mockResolvedValue({
    actorId: "22222222-2222-4222-8222-222222222222",
    sessionId: "u_server_bound_session",
    rateLimitKey: "user:22222222-2222-4222-8222-222222222222",
    kind: "user",
  });
  h.getSocialApiBaseUrl.mockReset().mockReturnValue("https://social.internal/");
  h.fetch.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ accepted: 1 }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function req(path: string, body: unknown): Request {
  return new Request(`https://swypik.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/v1/events identity binding", () => {
  it("overrides forged user/actor/session ids before proxying a single event", async () => {
    const res = await postOne(req("/api/v1/events", {
      type: "video_impression",
      actor_id: "victim-user",
      user_id: "victim-user",
      session_id: "attacker-session",
      subject_type: "video",
      subject_id: VIDEO,
    }));
    expect(res.status).toBe(202);

    const upstreamInit = h.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(upstreamInit.body));
    expect(payload.session_id).toBe("u_server_bound_session");
    expect(payload.events[0].actor_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(payload.events[0].actor_id).not.toBe("victim-user");
    expect(payload.events[0].metadata.identity_kind).toBe("user");
  });

  it("sends anonymous events without actor_id and with a server-issued session id", async () => {
    h.resolveIdentity.mockResolvedValue({
      actorId: null,
      sessionId: "a_server_anonymous_session",
      rateLimitKey: "anon:a_server_anonymous_session",
      kind: "anonymous",
    });
    const res = await postBatch(req("/api/v1/events/batch", {
      session_id: "forged-session",
      events: [{
        type: "video_start",
        actor_id: "victim-user",
        subject_type: "video",
        subject_id: VIDEO,
      }],
    }));
    expect(res.status).toBe(202);
    const payload = JSON.parse(String((h.fetch.mock.calls[0][1] as RequestInit).body));
    expect(payload.session_id).toBe("a_server_anonymous_session");
    expect(payload.events[0].actor_id).toBeUndefined();
    expect(payload.events[0].metadata.identity_kind).toBe("anonymous");
  });

  it("enforces the second, per-identity limiter before proxying", async () => {
    h.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 100 })
      .mockResolvedValueOnce({ success: false, remaining: 0 });
    const res = await postOne(req("/api/v1/events", {
      type: "video_impression",
      subject_type: "video",
      subject_id: VIDEO,
    }));
    expect(res.status).toBe(429);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
