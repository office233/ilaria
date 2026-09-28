import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import { FakeRedisBroker } from "./helpers/fake-redis-broker";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  hub: null as unknown,
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    if (sql.includes("INSERT INTO live_chat_messages")) {
      return { rows: state.rows.slice(-1), rowCount: 1 };
    }
    const lastId = Number(params[1] ?? 0);
    return { rows: state.rows.filter((r) => Number(r.id) > lastId), rowCount: 0 };
  }),
}));

vi.mock("@/lib/realtime", async () => {
  const actual = await vi.importActual<typeof import("@/lib/realtime")>("@/lib/realtime");
  return {
    ...actual,
    getRealtimeHub: () => state.hub,
    publishRealtime: (channel: string, payload: unknown) =>
      (state.hub as { publish: (c: string, p: unknown) => Promise<boolean> }).publish(channel, payload),
  };
});

import { createRealtimeHub, type RealtimeHub } from "@/lib/realtime/hub";
import { liveChatSseResponse, parseLastEventId, postLiveChatMessage } from "@/lib/live/chat-stream";

function makeHub(broker: FakeRedisBroker): RealtimeHub {
  const sub = broker.connect();
  const pub = broker.connect();
  return createRealtimeHub({ createSubscriber: () => sub as unknown as Redis, getPublisher: () => pub as unknown as Redis });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (t: string) => boolean) {
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < 30 && !predicate(text); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

const row = (id: number | string, message = `m${id}`) => ({
  id: String(id), // BIGSERIAL: pg îl întoarce ca string
  user_id: "u1",
  message,
  created_at: "2026-09-27T10:00:00Z",
  username: "ana",
  display_name: "Ana",
});
const STREAM = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.rows = [];
  state.queries = [];
});

describe("chat live — fan-out prin Redis, catch-up din DB", () => {
  it("catch-up după Last-Event-ID, apoi mesaje în timp real publicate de altă replică", async () => {
    const broker = new FakeRedisBroker();
    state.hub = makeHub(broker); // replica A (clientul)
    state.rows = [row(1), row(2), row(3)];
    const res = liveChatSseResponse(STREAM, 1, new AbortController().signal);
    const reader = res.body!.getReader();
    const initial = await readUntil(reader, (t) => t.includes("id: 3"));
    expect(initial).not.toContain("id: 1\n");
    expect(initial).toContain("id: 2\nevent: chat");

    // replica B inserează și publică
    state.hub = makeHub(broker);
    state.rows.push(row(4, "salut"));
    expect(await postLiveChatMessage(STREAM, "u1", "salut")).toMatchObject({ id: "4" });
    const live = await readUntil(reader, (t) => t.includes("salut"));
    expect(live).toContain("id: 4\nevent: chat");
    await reader.cancel();
  });

  it("dedup pe id: un mesaj primit și prin catch-up și prin pub/sub apare o singură dată; ordinea inversă nu pierde mesaje", async () => {
    const broker = new FakeRedisBroker();
    const hub = makeHub(broker);
    state.hub = hub;
    const res = liveChatSseResponse(STREAM, 0, new AbortController().signal);
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes("retry"));
    await new Promise((r) => setTimeout(r, 0));

    const publisher = makeHub(broker);
    await publisher.publish(`live:chat:${STREAM}`, row(6));
    await publisher.publish(`live:chat:${STREAM}`, row(5)); // publicat mai târziu de altă replică
    await publisher.publish(`live:chat:${STREAM}`, row(6)); // duplicat
    const text = await readUntil(reader, (t) => t.includes("id: 5"));
    expect(text.match(/id: 6\n/g)).toHaveLength(1);
    expect(text).toContain("id: 5\n");
    await reader.cancel();
  });

  it("stream care nu e live → null, fără publicare", async () => {
    const broker = new FakeRedisBroker();
    state.hub = makeHub(broker);
    const spy = vi.spyOn(state.hub as RealtimeHub, "publish");
    state.rows = [];
    expect(await postLiveChatMessage(STREAM, "u1", "x")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("parseLastEventId acceptă doar întregi pozitivi", () => {
    expect(parseLastEventId("42")).toBe(42);
    expect(parseLastEventId("-1")).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId(null)).toBe(0);
  });
});
