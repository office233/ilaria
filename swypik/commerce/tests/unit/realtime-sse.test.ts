import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createRealtimeHub } from "@/lib/realtime/hub";
import { createSseResponse, formatSseEvent } from "@/lib/realtime/sse";
import { _resetShutdownState, beginShutdown, isDraining, openLongLivedConnections } from "@/lib/runtime/shutdown";
import { FakeRedisBroker } from "./helpers/fake-redis-broker";

function hubOn(broker: FakeRedisBroker) {
  const sub = broker.connect();
  const pub = broker.connect();
  return createRealtimeHub({ createSubscriber: () => sub as unknown as Redis, getPublisher: () => pub as unknown as Redis });
}

async function readUntil(res: Response, predicate: (text: string) => boolean, maxChunks = 20): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxChunks && !predicate(text); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => _resetShutdownState());

describe("formatSseEvent", () => {
  it("formatează id, event și date multi-linie", () => {
    expect(formatSseEvent({ a: 1 }, { id: 7, event: "chat" })).toBe('id: 7\nevent: chat\ndata: {"a":1}\n\n');
    expect(formatSseEvent("x\ny")).toBe("data: x\ndata: y\n\n");
  });
});

describe("createSseResponse", () => {
  it("trimite snapshot-ul, apoi evenimentele publicate de ALTĂ replică", async () => {
    const broker = new FakeRedisBroker();
    const replicaA = hubOn(broker);
    const replicaB = hubOn(broker);
    const res = createSseResponse({
      logTag: "t",
      channels: ["dispatch:job:1"],
      hub: replicaA,
      onOpen: (send) => send({ type: "snapshot" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const first = await readUntil(res, (t) => t.includes("snapshot"));
    expect(first).toContain("retry: 3000");

    await tick();
    await replicaB.publish("dispatch:job:1", { type: "status", status: "assigned" });
    const next = await readUntil(res, (t) => t.includes("assigned"));
    expect(next).toContain('data: {"type":"status","status":"assigned"}');
    await res.body!.cancel();
    expect(replicaA.stats().listeners).toBe(0);
  });

  it("requireRealtime: abonare eșuată → eveniment error și stream închis", async () => {
    const broker = new FakeRedisBroker();
    const hub = hubOn(broker);
    broker.down = true;
    const res = createSseResponse({ logTag: "t", channels: ["c"], hub, requireRealtime: true });
    const text = await readUntil(res, () => false);
    expect(text).toContain("event: error");
  });

  it("SIGTERM: fiecare stream primește `reconnect` și se închide, replica devine draining", async () => {
    const broker = new FakeRedisBroker();
    const hub = hubOn(broker);
    const res = createSseResponse({ logTag: "t", channels: ["c"], hub, onOpen: (send) => send("ready") });
    await readUntil(res, (t) => t.includes("ready"));
    expect(openLongLivedConnections()).toBe(1);

    expect(beginShutdown("SIGTERM")).toBe(1);
    expect(isDraining()).toBe(true);
    const rest = await readUntil(res, () => false);
    expect(rest).toContain("event: reconnect");
    expect(openLongLivedConnections()).toBe(0);
    expect(hub.stats().listeners).toBe(0);
  });

  it("abort de la client eliberează abonarea", async () => {
    const broker = new FakeRedisBroker();
    const hub = hubOn(broker);
    const ctrl = new AbortController();
    const res = createSseResponse({ logTag: "t", channels: ["c"], hub, signal: ctrl.signal, onOpen: (s) => s("ok") });
    await readUntil(res, (t) => t.includes("ok"));
    expect(hub.stats().listeners).toBe(1);
    ctrl.abort();
    expect(hub.stats().listeners).toBe(0);
  });
});
