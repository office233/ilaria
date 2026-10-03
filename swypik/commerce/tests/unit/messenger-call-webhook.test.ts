import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { generateKeyPairSync, sign } from "crypto";

const h = vi.hoisted(() => ({
  call: null as { id: string; caller_id: string } | null,
  delivered: new Set<string>(),
  sql: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.sql.push({ sql, params });
    if (sql.includes("INSERT INTO realtime_webhook_deliveries")) {
      const id = String(params[0]);
      if (h.delivered.has(id)) return { rows: [] };
      h.delivered.add(id);
      return { rows: [{ delivery_id: id }] };
    }
    if (sql.includes("DELETE FROM realtime_webhook_deliveries")) {
      h.delivered.delete(String(params[0]));
      return { rows: [] };
    }
    if (sql.includes("FROM call_sessions WHERE rtk_meeting_id")) return { rows: h.call ? [h.call] : [] };
    if (sql.includes("RETURNING id")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  }),
}));

import { POST } from "@/app/api/messenger/calls/webhook/route";
import { resetRtkWebhookKeyCache, verifyRtkSignature } from "@/lib/realtime/rtk-webhook";

const CALLER = "11111111-1111-4111-8111-111111111111";
const CALLEE = "22222222-2222-4222-8222-222222222222";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signBody(body: string, key = privateKey): string {
  return sign("sha256", Buffer.from(body), key).toString("base64");
}

function webhook(payload: unknown, opts: { signature?: string | null; uuid?: string } = {}): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = opts.signature === undefined ? signBody(body) : opts.signature;
  if (sig) headers["rtk-signature"] = sig;
  if (opts.uuid) headers["rtk-uuid"] = opts.uuid;
  return new Request("http://localhost/api/messenger/calls/webhook", { method: "POST", headers, body });
}

function configure(on: boolean) {
  const vars = { CF_REALTIMEKIT_ACCOUNT_ID: "acct", CF_REALTIMEKIT_APP_ID: "app", CF_REALTIMEKIT_API_TOKEN: "tok" };
  for (const [k, v] of Object.entries(vars)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
}

beforeAll(() => {
  // PEM cu `\n` literale, ca într-un fișier .env.
  process.env.CF_REALTIMEKIT_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "\\n");
});

beforeEach(() => {
  configure(true);
  resetRtkWebhookKeyCache();
  h.call = { id: "call-1", caller_id: CALLER };
  h.delivered.clear();
  h.sql = [];
});

const meeting = { id: "rtk-meeting-1", endedAt: "2026-09-27T10:30:00.000Z" };

describe("verifyRtkSignature", () => {
  it("accepts only a base64 RSA-SHA256 signature of the exact raw body by the RealtimeKit key", async () => {
    const body = JSON.stringify({ event: "meeting.started", meeting });
    expect(await verifyRtkSignature(body, signBody(body))).toBe(true);
    expect(await verifyRtkSignature(body + " ", signBody(body))).toBe(false);
    expect(await verifyRtkSignature(body, signBody(body, other.privateKey))).toBe(false);
    expect(await verifyRtkSignature(body, null)).toBe(false);
    expect(await verifyRtkSignature(body, "not-base64!!")).toBe(false);
  });
});

describe("POST /api/messenger/calls/webhook", () => {
  it("503 when RealtimeKit is not configured", async () => {
    configure(false);
    expect((await POST(webhook({ event: "meeting.started", meeting }))).status).toBe(503);
  });

  it("401 on a missing or forged signature, before any DB access", async () => {
    expect((await POST(webhook({ event: "meeting.ended", meeting }, { signature: null }))).status).toBe(401);
    const forged = signBody(JSON.stringify({ event: "meeting.ended", meeting }), other.privateKey);
    expect((await POST(webhook({ event: "meeting.ended", meeting }, { signature: forged }))).status).toBe(401);
    expect(h.sql).toHaveLength(0);
  });

  it("callee join flips ringing → accepted and records the participant", async () => {
    const res = await POST(
      webhook({ event: "meeting.participantJoined", meeting, participant: { customParticipantId: CALLEE, joinedAt: "2026-09-27T10:01:00.000Z" } }),
    );
    expect(await res.json()).toMatchObject({ ok: true, outcome: "joined" });
    expect(h.sql.some((q) => q.sql.includes("INSERT INTO call_participants"))).toBe(true);
    const accept = h.sql.find((q) => q.sql.includes("UPDATE call_sessions") && q.sql.includes("SET status = 'accepted'"));
    expect(accept?.sql).toContain("status IN ('initiating', 'ringing')");
    expect(accept?.params).toEqual(["call-1", "2026-09-27T10:01:00.000Z"]);
  });

  it("the caller joining does not answer their own call", async () => {
    await POST(webhook({ event: "meeting.participantJoined", meeting, participant: { customParticipantId: CALLER } }));
    expect(h.sql.some((q) => q.sql.includes("UPDATE call_sessions") && q.sql.includes("SET status = 'accepted'"))).toBe(false);
  });

  it("meeting.ended ends answered calls, marks unanswered ones missed, keeps the reason", async () => {
    const res = await POST(webhook({ event: "meeting.ended", meeting, reason: "ALL_PARTICIPANTS_LEFT" }));
    expect(await res.json()).toMatchObject({ outcome: "ended" });
    const end = h.sql.find((q) => q.sql.includes("CASE WHEN answered_at IS NULL THEN 'missed' ELSE 'ended' END"));
    expect(end?.params).toEqual(["call-1", meeting.endedAt, "ALL_PARTICIPANTS_LEFT"]);
    expect(end?.sql).toContain("status IN ('initiating', 'ringing', 'accepted')");
  });

  it("ignores duplicate deliveries (rtk-uuid) and unknown meetings", async () => {
    const payload = { event: "meeting.ended", meeting, reason: "HOST_ENDED_MEETING" };
    await POST(webhook(payload, { uuid: "delivery-1" }));
    const again = await POST(webhook(payload, { uuid: "delivery-1" }));
    expect(await again.json()).toMatchObject({ outcome: "duplicate" });
    h.call = null;
    const unknown = await POST(webhook(payload, { uuid: "delivery-2" }));
    expect(await unknown.json()).toMatchObject({ outcome: "unknown_call" });
  });

  it("ignores a participant id that is not one of our user UUIDs", async () => {
    const res = await POST(webhook({ event: "meeting.participantJoined", meeting, participant: { customParticipantId: "x'; DROP" } }));
    expect(await res.json()).toMatchObject({ outcome: "noop" });
  });
});
