import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  userId: "user-b" as string | null,
  rtk: true,
  deactivate: vi.fn(async () => undefined),
  published: [] as Array<{ channel: string; payload: unknown }>,
  push: vi.fn(async () => undefined),
  call: { id: "c1", conversation_id: "conv-1", caller_id: "user-a", call_type: "video", status: "ringing", livekit_room_name: "r", rtk_meeting_id: "m-1", started_at: "t" },
}));

vi.mock("@/lib/social/session", () => ({ getAccountUserId: async () => h.userId }));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response(null, { status: 410 }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/realtime/config", () => ({ isRtkConfigured: () => h.rtk }));
vi.mock("@/lib/realtime/rtk", () => ({ deactivateMeeting: h.deactivate }));
vi.mock("@/lib/realtime", () => ({ publishRealtime: async (channel: string, payload: unknown) => { h.published.push({ channel, payload }); return true; } }));
vi.mock("@/lib/push/web-push", () => ({ sendPushToUser: h.push }));
vi.mock("@/lib/notifications/localized", () => ({ userLocale: async () => "en" }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string, v?: Record<string, string>) => `${k}${v?.name ? `:${v.name}` : ""}` }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("FROM conversation_participants WHERE conversation_id")) return { rows: [{ user_id: "user-a" }, { user_id: "user-c" }], rowCount: 2 };
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock("@/lib/messenger/calls", async (orig) => {
  const real = await orig<typeof import("@/lib/messenger/calls")>();
  return { ...real, declineCall: vi.fn(async () => h.call), endCall: vi.fn(async () => h.call) };
});

import { POST as decline } from "@/app/api/messenger/calls/[id]/decline/route";
import { POST as end } from "@/app/api/messenger/calls/[id]/end/route";
import { ringCallees } from "@/lib/messenger/call-ring";
import { declineCall, CallNotFoundError } from "@/lib/messenger/calls";

const CALL = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://x", { method: "POST" });

beforeEach(() => {
  h.userId = "user-b";
  h.rtk = true;
  h.deactivate.mockClear();
  h.push.mockClear();
  h.published = [];
});

describe("decline/end — id validat, meeting RealtimeKit închis, soneria oprită", () => {
  it("id non-UUID → 400 (nu 500 din Postgres)", async () => {
    expect((await decline(req(), ctx("abc"))).status).toBe(400);
    expect((await end(req(), ctx("1; drop"))).status).toBe(400);
  });

  it("decline → deactivateMeeting + event stop pe canalele celorlalți", async () => {
    const res = await decline(req(), ctx(CALL));
    expect(res.status).toBe(200);
    expect(h.deactivate).toHaveBeenCalledWith("m-1");
    expect(h.published.map((p) => p.channel)).toEqual(["call:user:user-a", "call:user:user-c"]);
    expect(h.published[0].payload).toEqual({ kind: "stop", callId: CALL });
  });

  it("end → meeting închis; eșecul RealtimeKit nu strică răspunsul", async () => {
    h.deactivate.mockRejectedValueOnce(new Error("cf down"));
    expect((await end(req(), ctx(CALL))).status).toBe(200);
  });

  it("apel inexistent → 404 cu cod stabil", async () => {
    vi.mocked(declineCall).mockRejectedValueOnce(new CallNotFoundError());
    const res = await decline(req(), ctx(CALL));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("call_not_found");
  });

  it("fără cont → 401", async () => {
    h.userId = null;
    expect((await end(req(), ctx(CALL))).status).toBe(401);
  });
});

describe("ringCallees — sună oriunde", () => {
  it("publică ring pe canalul fiecărui destinatar + Web Push tradus, fără apelant", async () => {
    await ringCallees({ callId: "c9", conversationId: "conv-1", callerId: "user-b", callerName: "Ana", callType: "video" });
    expect(h.published).toEqual([
      { channel: "call:user:user-a", payload: { kind: "ring", callId: "c9" } },
      { channel: "call:user:user-c", payload: { kind: "ring", callId: "c9" } },
    ]);
    expect(h.push).toHaveBeenCalledWith("user-a", expect.objectContaining({ title: "pushTitleVideo:Ana", url: "/messages/conv-1", tag: "call:c9" }));
  });
});
