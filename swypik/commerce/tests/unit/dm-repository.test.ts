import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbQuery, publish, notifyUser, state } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  publish: vi.fn(async () => 1),
  notifyUser: vi.fn(async () => undefined),
  state: { participant: true, blocks: [] as Array<{ blocker_user_id: string }>, coalesced: false },
}));

vi.mock("@/lib/db", () => ({ dbQuery }));
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ publish }) }));
vi.mock("@/lib/notifications/dispatch", () => ({ notifyUser }));
vi.mock("@/lib/notifications/localized", () => ({ userLocale: async () => "en" }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) => (values?.name ? `${key}:${values.name}` : key),
}));

import { getOrCreateDmConversation, markRead, sendMessage } from "@/lib/dm/repository";
import { notifyNewDirectMessage } from "@/lib/dm/notify";
import { mergeIncoming } from "@/components/messenger/chat/useChat";
import { lastSeenOwnMessageId } from "@/components/messenger/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONV = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  state.participant = true;
  state.blocks = [];
  state.coalesced = false;
  publish.mockClear();
  notifyUser.mockClear();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM conversation_participants") && sql.includes("user_id = $2") && sql.includes("SELECT 1")) {
      return { rows: state.participant ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("FROM user_blocks") && sql.includes("AS blocked")) return { rows: [{ blocked: state.blocks.length > 0 }] };
    if (sql.includes("FROM user_blocks")) return { rows: state.blocks };
    if (sql.includes("user_id <> $2")) return { rows: [{ user_id: B }] };
    if (sql.includes("INSERT INTO messages")) {
      return { rows: [{ id: "m1", conversation_id: CONV, sender_id: params[1], body: params[2], media_url: params[3], created_at: "2026-09-25T10:00:00Z" }] };
    }
    if (sql.includes("INSERT INTO conversations")) return { rows: [{ id: CONV, is_new: true }] };
    if (sql.includes("RETURNING last_read_at")) return { rows: [{ last_read_at: "2026-09-25T10:05:00Z" }] };
    if (sql.includes("UPDATE notifications") && sql.includes("RETURNING id")) {
      return { rows: state.coalesced ? [{ id: "n1" }] : [] };
    }
    if (sql.includes("FROM users")) return { rows: [{ display_name: "Ana", username: "ana" }] };
    return { rows: [] };
  });
});

describe("DM blocks", () => {
  it("refuses to open a conversation when either side blocked the other", async () => {
    state.blocks = [{ blocker_user_id: B }];
    await expect(getOrCreateDmConversation(A, B)).rejects.toMatchObject({ status: 403, code: "blocked" });
    expect(dbQuery.mock.calls.some((c) => String(c[0]).includes("INSERT INTO conversations"))).toBe(false);
  });

  it("opens (or reuses) the DM through the unique pair key", async () => {
    const res = await getOrCreateDmConversation(B, A);
    expect(res).toEqual({ conversationId: CONV, isNew: true });
    const insert = dbQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO conversations"));
    expect(insert?.[0]).toContain("ON CONFLICT (dm_key)");
    expect(insert?.[1]).toEqual([B, A, `${A}:${B}`]);
  });

  it("refuses to send when blocked, before inserting anything", async () => {
    state.blocks = [{ blocker_user_id: A }];
    await expect(sendMessage(A, CONV, { body: "hi" })).rejects.toMatchObject({ status: 403, code: "blocked" });
    expect(dbQuery.mock.calls.some((c) => String(c[0]).includes("INSERT INTO messages"))).toBe(false);
  });

  it("rejects non-participants with 403", async () => {
    state.participant = false;
    await expect(sendMessage(A, CONV, { body: "hi" })).rejects.toMatchObject({ status: 403 });
  });

  it("accepts an image message without text and publishes a typed event", async () => {
    const msg = await sendMessage(A, CONV, { body: "", mediaUrl: "https://cdn.example/dm/x.jpg" });
    expect(msg.media_url).toBe("https://cdn.example/dm/x.jpg");
    expect(publish).toHaveBeenCalledWith(`dm:conv:${CONV}`, expect.stringContaining('"type":"message"'));
  });

  it("rejects an empty message with no image", async () => {
    await expect(sendMessage(A, CONV, { body: "   " })).rejects.toMatchObject({ status: 400 });
  });
});

describe("read receipts", () => {
  it("marks read, clears the DM notification and tells the peer", async () => {
    await markRead(CONV, A);
    expect(dbQuery.mock.calls.some((c) => String(c[0]).includes("notification_type = 'message'"))).toBe(true);
    expect(publish).toHaveBeenCalledWith(`dm:conv:${CONV}`, expect.stringContaining('"type":"read"'));
  });

  it("shows 'seen' only on the last own message read by the peer", () => {
    const msgs = [
      { id: "1", sender_id: A, body: "a", media_url: null, created_at: "2026-09-25T10:00:00Z" },
      { id: "2", sender_id: A, body: "b", media_url: null, created_at: "2026-09-25T10:02:00Z" },
      { id: "3", sender_id: A, body: "c", media_url: null, created_at: "2026-09-25T10:09:00Z" },
    ];
    expect(lastSeenOwnMessageId(msgs, A, "2026-09-25T10:05:00Z")).toBe("2");
    expect(lastSeenOwnMessageId(msgs, A, null)).toBeNull();
  });

  it("replaces the optimistic bubble instead of duplicating it", () => {
    const pending = { id: "temp_1", sender_id: A, body: "hi", media_url: null, created_at: "x", pending: true };
    const confirmed = { id: "m1", sender_id: A, body: "hi", media_url: null, created_at: "y" };
    expect(mergeIncoming([pending], confirmed)).toEqual([confirmed]);
    expect(mergeIncoming([confirmed], confirmed)).toEqual([confirmed]);
  });
});

describe("DM notifications", () => {
  const input = { recipientId: B, senderId: A, conversationId: CONV, body: "Hello there", hasMedia: false };

  it("creates one localized 'message' notification linking to /messages/<id>", async () => {
    await notifyNewDirectMessage(input);
    expect(notifyUser).toHaveBeenCalledWith(
      B,
      expect.objectContaining({
        type: "message",
        payload: expect.objectContaining({ url: `/messages/${CONV}`, conversation_id: CONV, title: "title:Ana" }),
      }),
    );
  });

  it("coalesces further messages into the unread notification", async () => {
    state.coalesced = true;
    await notifyNewDirectMessage(input);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("never notifies the sender", async () => {
    await notifyNewDirectMessage({ ...input, recipientId: A });
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
