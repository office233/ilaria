import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/**
 * Simulează `pg_try_advisory_xact_lock`: lock global (partajat de toate
 * „replicile”), ținut cât durează tranzacția-santinelă, eliberat la final.
 */
const pg = vi.hoisted(() => ({
  held: new Set<string>(),
  audits: [] as Array<{ status: string; params: unknown[] }>,
}));

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) => {
    const mine: string[] = [];
    const q = async (sql: string, params: unknown[] = []) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        const key = String(params[0]);
        if (pg.held.has(key)) return { rows: [{ acquired: false }], rowCount: 1 };
        pg.held.add(key);
        mine.push(key);
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    try {
      return await fn(q);
    } finally {
      for (const k of mine) pg.held.delete(k); // COMMIT/ROLLBACK eliberează lock-ul
    }
  },
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("cron_runs")) pg.audits.push({ status: String(params[1]), params });
    return { rows: [], rowCount: 1 };
  }),
}));

import { withAdvisoryLock, withCronLock, cronLockKey } from "@/lib/cron/lock";
import { runCron } from "@/lib/cron/runCron";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  pg.held.clear();
  pg.audits = [];
});

describe("withAdvisoryLock", () => {
  it("două execuții concurente (două replici) → exact una rulează jobul", async () => {
    const gate = deferred();
    const job = vi.fn(async () => {
      await gate.promise;
      return "done";
    });
    const first = withAdvisoryLock("cron:x", job);
    const second = await withAdvisoryLock("cron:x", job);
    expect(second).toEqual({ acquired: false });
    gate.resolve();
    expect(await first).toEqual({ acquired: true, value: "done" });
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("lock-ul se eliberează și dacă jobul aruncă (rularea următoare îl poate lua)", async () => {
    await expect(withAdvisoryLock("cron:y", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withAdvisoryLock("cron:y", async () => 1)).toEqual({ acquired: true, value: 1 });
  });

  it("chei diferite nu se blochează reciproc", async () => {
    const gate = deferred();
    const slow = withAdvisoryLock("cron:a", () => gate.promise);
    expect(await withAdvisoryLock("cron:b", async () => "b")).toEqual({ acquired: true, value: "b" });
    gate.resolve();
    await slow;
  });
});

describe("withCronLock", () => {
  it("rularea concurentă primește 200 skipped (nu alertă în cron-worker)", async () => {
    const gate = deferred();
    const first = withCronLock("dispatch-tick", async () => {
      await gate.promise;
      return Response.json({ success: true });
    });
    const skipped = await withCronLock("dispatch-tick", async () => Response.json({ success: true }));
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ skipped: true, job: "dispatch-tick", reason: "locked" });
    gate.resolve();
    expect(await (await first).json()).toEqual({ success: true });
    expect(cronLockKey("dispatch-tick")).toBe("cron:dispatch-tick");
  });
});

describe("runCron", () => {
  it("audit success / skipped / failed în cron_runs", async () => {
    expect(await runCron("job", async () => ({ n: 1 }))).toEqual({ n: 1 });

    const gate = deferred();
    const running = runCron("job", () => gate.promise.then(() => "late"));
    expect(await runCron("job", async () => "never")).toBeNull();
    gate.resolve();
    await running;

    await expect(runCron("job", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(pg.audits.map((a) => a.status)).toEqual(["success", "skipped", "success", "failed"]);
  });
});
