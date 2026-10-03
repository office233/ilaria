import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  userId: null as string | null,
  order: [] as string[],
  createMeeting: vi.fn(),
  addParticipant: vi.fn(),
  prepareCall: vi.fn(),
  createCall: vi.fn(),
  joinCall: vi.fn(),
}));

vi.mock("@/lib/social/session", () => ({ getAccountUserId: async () => h.userId }));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response(null, { status: 404 }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/db", () => ({ dbQuery: async () => ({ rows: [{ display_name: "Ana", username: "ana" }] }) }));
vi.mock("@/lib/realtime/rtk", () => ({ createMeeting: h.createMeeting, addParticipant: h.addParticipant }));
vi.mock("@/lib/messenger/calls", async (orig) => {
  const actual = await orig<typeof import("@/lib/messenger/calls")>();
  return { ...actual, prepareCall: h.prepareCall, createCall: h.createCall, joinCall: h.joinCall };
});

import { POST } from "@/app/api/messenger/calls/token/route";
import { CallAuthError } from "@/lib/messenger/calls";
import { RealtimeApiError } from "@/lib/realtime/http";

const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const CALL = "44444444-4444-4444-8444-444444444444";

function req(body: unknown) {
  return new Request("http://localhost/api/messenger/calls/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function configure(on: boolean) {
  const vars = { CF_REALTIMEKIT_ACCOUNT_ID: "acct", CF_REALTIMEKIT_APP_ID: "app", CF_REALTIMEKIT_API_TOKEN: "tok" };
  for (const [k, v] of Object.entries(vars)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
}

beforeEach(() => {
  configure(true);
  h.userId = USER;
  h.order = [];
  h.prepareCall.mockReset().mockImplementation(async () => (h.order.push("prepare"), { roomName: "swypik_call_x" }));
  h.createMeeting.mockReset().mockImplementation(async () => (h.order.push("meeting"), "rtk-meeting-1"));
  h.addParticipant.mockReset().mockImplementation(async () => (h.order.push("participant"), { participantId: "p1", authToken: "jwt-token" }));
  h.createCall.mockReset().mockImplementation(async () => (h.order.push("insert"), { callId: CALL }));
  h.joinCall.mockReset().mockResolvedValue({ meetingId: "rtk-meeting-1", callType: "audio" });
});

describe("POST /api/messenger/calls/token (RealtimeKit)", () => {
  it("401 for anonymous users, 503 when RealtimeKit keys are missing (nothing created)", async () => {
    h.userId = null;
    expect((await POST(req({ conversationId: CONV }))).status).toBe(401);
    h.userId = USER;
    configure(false);
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("calls_unavailable");
    expect(h.createMeeting).not.toHaveBeenCalled();
    expect(h.createCall).not.toHaveBeenCalled();
  });

  it("new call: authorizes, creates meeting + participant, and only then writes the ringing row", async () => {
    const res = await POST(req({ conversationId: CONV, callType: "audio" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, callId: CALL, authToken: "jwt-token", callType: "audio" });
    expect(h.order).toEqual(["prepare", "meeting", "participant", "insert"]);
    expect(h.addParticipant).toHaveBeenCalledWith("rtk-meeting-1", { userId: USER, name: "Ana", media: "audio" });
    expect(h.createCall).toHaveBeenCalledWith(USER, CONV, "audio", { roomName: "swypik_call_x", meetingId: "rtk-meeting-1" });
  });

  it("a non-participant is refused before any provider call", async () => {
    h.prepareCall.mockRejectedValue(new CallAuthError("Not a participant of this conversation", 403));
    expect((await POST(req({ conversationId: CONV }))).status).toBe(403);
    expect(h.createMeeting).not.toHaveBeenCalled();
  });

  it("provider failure → 502 and no orphan ringing row", async () => {
    h.addParticipant.mockRejectedValue(new RealtimeApiError(400, "preset_not_found", "preset"));
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(502);
    expect(h.createCall).not.toHaveBeenCalled();
  });

  it("join: issues a token for the call's meeting with the call's media preset", async () => {
    const res = await POST(req({ callId: CALL }));
    expect(await res.json()).toMatchObject({ callId: CALL, authToken: "jwt-token", callType: "audio" });
    expect(h.addParticipant).toHaveBeenCalledWith("rtk-meeting-1", { userId: USER, name: "Ana", media: "audio" });
  });

  it("join: ended calls are refused with 410", async () => {
    h.joinCall.mockRejectedValue(new CallAuthError("Call is no longer active", 410));
    expect((await POST(req({ callId: CALL }))).status).toBe(410);
    expect(h.addParticipant).not.toHaveBeenCalled();
  });
});
