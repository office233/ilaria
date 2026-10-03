import { describe, it, expect, vi } from "vitest";
import type { Redis } from "ioredis";
import { FakeRedisBroker } from "./helpers/fake-redis-broker";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/**
 * Două „replici” = două instanțe izolate ale modulului (vi.resetModules), fiecare
 * cu propriul hub realtime, pe același broker Redis.
 */
async function loadReplica(broker: FakeRedisBroker) {
  vi.resetModules();
  const sub = broker.connect();
  const pub = broker.connect();
  const { createRealtimeHub } = await import("@/lib/realtime/hub");
  const hub = createRealtimeHub({ createSubscriber: () => sub as unknown as Redis, getPublisher: () => pub as unknown as Redis });
  vi.doMock("@/lib/realtime", () => ({ getRealtimeHub: () => hub, realtimeChannels: { cacheInvalidate: "cache:invalidate" } }));
  const mod = await import("@/lib/cache/invalidation");
  vi.doUnmock("@/lib/realtime");
  return mod;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("invalidare cache cross-replică", () => {
  it("broadcast pe replica A golește cache-ul local al replicii B", async () => {
    const broker = new FakeRedisBroker();
    const a = await loadReplica(broker);
    const b = await loadReplica(broker);
    const resetA = vi.fn();
    const resetB = vi.fn();
    a.onCacheInvalidate("fly:route-markup", resetA);
    b.onCacheInvalidate("fly:route-markup", resetB);
    b.onCacheInvalidate("other", () => {
      throw new Error("nu trebuie apelat");
    });
    await flush();

    await a.broadcastCacheInvalidate("fly:route-markup");
    expect(resetB).toHaveBeenCalledTimes(1);
    expect(resetA).toHaveBeenCalled(); // local imediat (+ ecoul propriu, idempotent)
  });

  it("fără Redis: invalidarea locală tot are loc", async () => {
    const broker = new FakeRedisBroker();
    broker.down = true;
    const a = await loadReplica(broker);
    const reset = vi.fn();
    a.onCacheInvalidate("x", reset);
    await flush();
    await a.broadcastCacheInvalidate("x");
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
