import { describe, it, expect, vi } from "vitest";
import type { Redis } from "ioredis";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createRealtimeHub } from "@/lib/realtime/hub";
import { FakeRedisBroker } from "./helpers/fake-redis-broker";

/** O „replică” = un hub cu propria conexiune de abonare + publisher, pe brokerul comun. */
function replica(broker: FakeRedisBroker) {
  const subscriber = broker.connect();
  const publisher = broker.connect();
  const hub = createRealtimeHub({
    createSubscriber: () => subscriber as unknown as Redis,
    getPublisher: () => publisher as unknown as Redis,
  });
  return { hub, subscriber };
}

describe("realtime hub — fan-out între replici", () => {
  it("un eveniment publicat pe replica B ajunge la clientul conectat pe replica A", async () => {
    const broker = new FakeRedisBroker();
    const a = replica(broker);
    const b = replica(broker);
    const received: string[] = [];
    await a.hub.subscribe("dm:conv:1", (m) => received.push(m));

    expect(await b.hub.publish("dm:conv:1", { type: "message", id: "m1" })).toBe(true);
    expect(received).toEqual([JSON.stringify({ type: "message", id: "m1" })]);
  });

  it("o singură abonare Redis per canal, indiferent de numărul de clienți locali", async () => {
    const broker = new FakeRedisBroker();
    const a = replica(broker);
    const got: string[] = [];
    const off1 = await a.hub.subscribe("dispatch:job:1", (m) => got.push(`c1:${m}`));
    const off2 = await a.hub.subscribe("dispatch:job:1", (m) => got.push(`c2:${m}`));
    expect(a.subscriber.subscribeCalls).toEqual(["dispatch:job:1"]);
    expect(a.hub.stats()).toEqual({ channels: 1, listeners: 2 });

    await replica(broker).hub.publish("dispatch:job:1", "x");
    expect(got).toEqual(["c1:x", "c2:x"]);

    off1();
    expect(a.subscriber.unsubscribeCalls).toEqual([]);
    off2();
    off2(); // idempotent
    expect(a.subscriber.unsubscribeCalls).toEqual(["dispatch:job:1"]);
    expect(a.hub.stats()).toEqual({ channels: 0, listeners: 0 });
  });

  it("izolează un ascultător care aruncă și nu livrează pe alte canale", async () => {
    const broker = new FakeRedisBroker();
    const a = replica(broker);
    const got: string[] = [];
    await a.hub.subscribe("c1", () => {
      throw new Error("boom");
    });
    await a.hub.subscribe("c1", (m) => got.push(m));
    await a.hub.subscribe("c2", (m) => got.push(`c2:${m}`));
    await a.hub.publish("c1", "hello");
    expect(got).toEqual(["hello"]);
  });

  it("Redis căzut: publish întoarce false, subscribe aruncă și nu lasă ascultători orfani", async () => {
    const broker = new FakeRedisBroker();
    const a = replica(broker);
    broker.down = true;
    expect(await a.hub.publish("c", "x")).toBe(false);
    await expect(a.hub.subscribe("c", () => undefined)).rejects.toThrow();
    expect(a.hub.stats()).toEqual({ channels: 0, listeners: 0 });
  });

  it("healthy() reflectă starea conexiunii de abonare", async () => {
    const broker = new FakeRedisBroker();
    const a = replica(broker);
    expect(a.hub.healthy()).toBe(false); // încă neconectat
    await a.hub.subscribe("c", () => undefined);
    expect(a.hub.healthy()).toBe(true);
    a.subscriber.status = "reconnecting";
    expect(a.hub.healthy()).toBe(false);
  });
});
