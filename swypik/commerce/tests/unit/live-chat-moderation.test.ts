import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  session: { userId: "11111111-1111-4111-8111-111111111111", role: "shopper" } as { userId: string; role: string } | null,
  verdict: { flagged: false, reasons: [] as string[], decision: "allow", maxSeverity: 0 },
  banned: false,
  stream: { id: "s", status: "live", creator_id: "host-1" } as Record<string, unknown> | null,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  published: [] as Array<{ channel: string; payload: unknown }>,
  author: { user_id: "author-1", message: "rău" } as { user_id: string; message: string } | null,
  limited: false,
}));

vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => h.session }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: !h.limited, remaining: 0 }),
  getClientIP: () => "1.2.3.4",
}));
vi.mock("@/lib/ai/moderate", () => ({ moderate: async () => h.verdict }));
vi.mock("@/lib/live/queries", () => ({ getLiveStream: async () => h.stream }));
vi.mock("@/lib/realtime", () => ({
  publishRealtime: async (channel: string, payload: unknown) => void h.published.push({ channel, payload }),
  realtimeChannels: { liveChat: (id: string) => `live:chat:${id}` },
  getRealtimeHub: () => ({ healthy: () => true }),
}));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.queries.push({ sql, params });
    if (sql.includes("FROM live_chat_bans")) return { rows: [{ banned: h.banned }], rowCount: 1 };
    if (sql.includes("INSERT INTO live_chat_messages")) {
      return { rows: [{ id: "7", message: params[2], created_at: "t", username: "ana", display_name: "Ana", avatar_url: null }], rowCount: 1 };
    }
    if (sql.includes("SELECT creator_id FROM live_streams")) return { rows: h.stream ? [{ creator_id: h.stream.creator_id }] : [], rowCount: 1 };
    if (sql.includes("SELECT user_id, message FROM live_chat_messages")) return { rows: h.author ? [h.author] : [], rowCount: 1 };
    if (sql.includes("UPDATE live_chat_messages")) return { rows: [{ id: "7" }, { id: "9" }], rowCount: 2 };
    return { rows: [], rowCount: 1 };
  }),
}));

import { POST as chatPost, GET as chatGet } from "@/app/api/live/streams/[id]/chat/route";
import { POST as moderatePost } from "@/app/api/live/streams/[id]/chat/moderate/route";
import { POST as reportPost } from "@/app/api/live/streams/[id]/chat/report/route";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ctx = { params: Promise.resolve({ id: ID }) };
const post = (body: unknown) => new Request(`http://x/api/live/streams/${ID}/chat`, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  h.session = { userId: "11111111-1111-4111-8111-111111111111", role: "shopper" };
  h.verdict = { flagged: false, reasons: [], decision: "allow", maxSeverity: 0 };
  h.banned = false;
  h.stream = { id: ID, status: "live", creator_id: "host-1" };
  h.queries = [];
  h.published = [];
  h.author = { user_id: "author-1", message: "rău" };
  h.limited = false;
});

describe("chat live — Content Safety + blocare + fără user_id", () => {
  it("mesaj curat → publicat; payload-ul public nu conține user_id", async () => {
    const res = await chatPost(post({ message: "salut" }) as never, ctx);
    expect(res.status).toBe(200);
    const ins = h.queries.find((q) => q.sql.includes("INSERT INTO live_chat_messages"));
    expect(ins?.sql).toContain("live_chat_bans");
    expect(ins?.sql).not.toMatch(/SELECT m\.id, m\.user_id/);
    expect(JSON.stringify(h.published)).not.toContain("user_id");
  });

  it("marcat de Content Safety → 422 message_blocked, nimic inserat", async () => {
    h.verdict = { flagged: true, reasons: ["hate:6"], decision: "block", maxSeverity: 6 };
    const res = await chatPost(post({ message: "x" }) as never, ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("message_blocked");
    expect(h.queries.some((q) => q.sql.includes("INSERT INTO live_chat_messages"))).toBe(false);
  });

  it("Content Safety indisponibil → 503 (fail-closed)", async () => {
    h.verdict = { flagged: true, reasons: ["moderation_unavailable"], decision: "unavailable", maxSeverity: 0 };
    expect((await chatPost(post({ message: "x" }) as never, ctx)).status).toBe(503);
  });

  it("utilizator blocat de gazdă → 403 chat_banned", async () => {
    h.banned = true;
    const res = await chatPost(post({ message: "salut" }) as never, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("chat_banned");
  });

  it("SSE doar pentru streamuri existente live/programate", async () => {
    const sse = () => new Request(`http://x/api/live/streams/${ID}/chat`, { headers: { accept: "text/event-stream" } });
    h.stream = null;
    expect((await chatGet(sse() as never, ctx)).status).toBe(404);
    h.stream = { id: ID, status: "ended", creator_id: "host-1" };
    expect((await chatGet(sse() as never, ctx)).status).toBe(410);
    h.limited = true;
    expect((await chatGet(sse() as never, ctx)).status).toBe(429);
  });
});

describe("moderare de către gazdă + raport", () => {
  const mod = (body: unknown) => moderatePost(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), ctx);

  it("doar gazda (sau admin) poate ascunde/bloca", async () => {
    expect((await mod({ messageId: 7, action: "hide" })).status).toBe(403);
    h.session = { userId: "host-1", role: "creator" };
    const res = await mod({ messageId: 7, action: "hide" });
    expect(res.status).toBe(200);
    expect(h.published.at(-1)).toEqual({ channel: `live:chat:${ID}`, payload: { removedIds: [7] } });
  });

  it("ban → rând în live_chat_bans pentru autorul găsit pe server + mesajele retrase", async () => {
    h.session = { userId: "host-1", role: "creator" };
    const res = await mod({ messageId: 7, action: "ban" });
    expect(res.status).toBe(200);
    const ban = h.queries.find((q) => q.sql.includes("INSERT INTO live_chat_bans"));
    expect(ban?.params).toEqual([ID, "author-1", "host-1"]);
    expect(await res.json()).toEqual({ ok: true, removedIds: [7, 9] });
  });

  it("gazda nu se poate bloca singură", async () => {
    h.session = { userId: "host-1", role: "creator" };
    h.author = { user_id: "host-1", message: "m" };
    expect((await mod({ messageId: 7, action: "ban" })).status).toBe(422);
  });

  it("raport → moderation_reports cu contextul mesajului; fără sesiune → 401", async () => {
    const rep = (body: unknown) => reportPost(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), ctx);
    expect((await rep({ messageId: 7, reason: "hate" })).status).toBe(201);
    const ins = h.queries.find((q) => q.sql.includes("INSERT INTO moderation_reports"));
    expect(ins?.params[2]).toBe("hate");
    expect(String(ins?.params[3])).toContain('"kind":"live_chat"');
    h.session = null;
    expect((await rep({ messageId: 7 })).status).toBe(401);
  });
});
