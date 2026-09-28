import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

let participantMap: Record<string, boolean> = {};
const queries: string[] = [];
let call: Row | null = null;
let updateCalls: { sql: string; params: unknown[] }[] = [];

vi.mock("@/lib/dm/repository", () => ({
  assertParticipant: vi.fn(async (conversationId: string, userId: string) => {
    return participantMap[`${conversationId}:${userId}`] ?? false;
  }),
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("SET status = 'missed'")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id, conversation_id, caller_id")) {
      return { rows: call ? [call] : [], rowCount: call ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO call_sessions")) {
      call = {
        id: "call-1",
        conversation_id: params[0],
        caller_id: params[1],
        call_type: params[2],
        status: "ringing",
        livekit_room_name: params[3],
        rtk_meeting_id: params[4],
        started_at: new Date().toISOString(),
      };
      return { rows: [{ id: "call-1" }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'accepted'")) {
      updateCalls.push({ sql, params });
      if (call) call.status = "accepted";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'rejected'")) {
      updateCalls.push({ sql, params });
      if (call) call.status = "rejected";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'ended'")) {
      updateCalls.push({ sql, params });
      if (call) call.status = "ended";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT cs.id, cs.conversation_id")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error("unexpected sql: " + sql.slice(0, 60));
  }),
}));

import {
  prepareCall,
  createCall,
  joinCall,
  declineCall,
  endCall,
  listIncomingCalls,
  CallAuthError,
  CallNotFoundError,
} from "@/lib/messenger/calls";

const MEDIA = { roomName: "swypik_call_test", meetingId: "rtk-meeting-1" };

beforeEach(() => {
  participantMap = {};
  queries.length = 0;
  call = null;
  updateCalls = [];
});

describe("messenger/calls authorization", () => {
  it("createCall throws when caller is not a participant of the conversation", async () => {
    participantMap["conv-1:userA"] = false;
    await expect(createCall("userA", "conv-1", "video", MEDIA)).rejects.toBeInstanceOf(CallAuthError);
  });

  it("prepareCall refuses non-participants and returns a fresh room key without writing", async () => {
    participantMap["conv-1:userA"] = false;
    await expect(prepareCall("userA", "conv-1")).rejects.toBeInstanceOf(CallAuthError);
    participantMap["conv-1:userA"] = true;
    const { roomName } = await prepareCall("userA", "conv-1");
    expect(roomName).toMatch(/^swypik_call_/);
    expect(queries.some((q) => q.includes("INSERT"))).toBe(false);
  });

  it("createCall inserts a ringing RealtimeKit call bound to its meeting", async () => {
    participantMap["conv-1:userA"] = true;
    const result = await createCall("userA", "conv-1", "video", MEDIA);
    expect(result.callId).toBe("call-1");
    expect(call).toMatchObject({ status: "ringing", caller_id: "userA", rtk_meeting_id: "rtk-meeting-1" });
    expect(queries.find((q) => q.includes("INSERT INTO call_sessions"))).toContain("'cf_rtk'");
  });

  it("joinCall throws CallNotFoundError for an unknown call id", async () => {
    await expect(joinCall("userA", "missing-call")).rejects.toBeInstanceOf(CallNotFoundError);
  });

  it("joinCall throws CallAuthError when the joiner is not a participant of the call's conversation", async () => {
    participantMap["conv-1:userA"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    participantMap["conv-1:userB"] = false;
    await expect(joinCall("userB", "call-1")).rejects.toBeInstanceOf(CallAuthError);
  });

  it("joinCall accepts a ringing call when a non-caller participant joins", async () => {
    participantMap["conv-1:userA"] = true;
    participantMap["conv-1:userB"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    const joined = await joinCall("userB", "call-1");
    expect(joined).toEqual({ meetingId: "rtk-meeting-1", callType: "video" });
    expect(call?.status).toBe("accepted");
  });

  it("joinCall refuses a token for a call that is already over", async () => {
    participantMap["conv-1:userA"] = true;
    participantMap["conv-1:userB"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    await endCall("userA", "call-1");
    await expect(joinCall("userB", "call-1")).rejects.toMatchObject({ status: 410 });
  });

  it("joinCall does not flip status when the original caller rejoins their own ringing call", async () => {
    participantMap["conv-1:userA"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    await joinCall("userA", "call-1");
    expect(call?.status).toBe("ringing");
  });

  it("joinCall refuses legacy LiveKit calls that have no RealtimeKit meeting", async () => {
    participantMap["conv-1:userA"] = true;
    participantMap["conv-1:userB"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    if (call) call.rtk_meeting_id = null;
    await expect(joinCall("userB", "call-1")).rejects.toMatchObject({ status: 410 });
  });

  it("declineCall refuses when the caller tries to decline their own call", async () => {
    participantMap["conv-1:userA"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    await expect(declineCall("userA", "call-1")).rejects.toBeInstanceOf(CallAuthError);
  });

  it("declineCall rejects a ringing call for a non-caller participant", async () => {
    participantMap["conv-1:userA"] = true;
    participantMap["conv-1:userB"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    await declineCall("userB", "call-1");
    expect(call?.status).toBe("rejected");
  });

  it("endCall requires the ender to be a participant", async () => {
    participantMap["conv-1:userA"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    await expect(endCall("userC", "call-1")).rejects.toBeInstanceOf(CallAuthError);
  });

  it("endCall marks the call ended for a valid participant", async () => {
    participantMap["conv-1:userA"] = true;
    await createCall("userA", "conv-1", "video", MEDIA);
    await endCall("userA", "call-1");
    expect(call?.status).toBe("ended");
  });

  it("listIncomingCalls sweeps stale ringing calls before querying", async () => {
    await listIncomingCalls("userB");
    expect(queries[0]).toContain("SET status = 'missed'");
  });
});
