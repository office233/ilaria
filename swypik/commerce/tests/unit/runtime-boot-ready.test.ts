import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const health = vi.hoisted(() => ({
  db: { status: "ok", latency_ms: 1, detail: {} } as { status: string; latency_ms: number; detail: Record<string, unknown> },
  redis: { status: "ok", latency_ms: 1, detail: {} } as { status: string; latency_ms: number; detail: Record<string, unknown> },
}));
vi.mock("@/lib/health", () => ({ checkDb: async () => health.db, checkRedis: async () => health.redis }));

import { assertProductionEnv, findEnvProblems, shouldCheckEnv } from "@/lib/runtime/env-check";
import { _resetShutdownState, beginShutdown } from "@/lib/runtime/shutdown";
import { GET as ready } from "@/app/api/ready/route";

const GOOD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://db/x",
  REDIS_URL: "redis://redis:6379",
  APP_ENCRYPTION_KEY: "a".repeat(64),
  CRON_SECRET: "s3cret",
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  _resetShutdownState();
  health.db = { status: "ok", latency_ms: 1, detail: {} };
  health.redis = { status: "ok", latency_ms: 1, detail: {} };
});

describe("env-check (fail fast la boot)", () => {
  it("producție completă → fără probleme, fără exit", () => {
    const exit = vi.fn();
    expect(assertProductionEnv(GOOD, exit)).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("secret lipsă sau cheie invalidă → log clar + exit(1)", () => {
    const exit = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { ...GOOD, REDIS_URL: "", APP_ENCRYPTION_KEY: "short" } as NodeJS.ProcessEnv;
    const problems = assertProductionEnv(env, exit);
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toMatch(/REDIS_URL lipsește/);
    expect(problems.join(" ")).toMatch(/APP_ENCRYPTION_KEY invalid/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(spy.mock.calls[0][0]).toContain("FATAL");
    spy.mockRestore();
  });

  it("nu verifică în dev, la build sau cu SKIP_ENV_CHECK=1", () => {
    expect(shouldCheckEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldCheckEnv({ ...GOOD, NEXT_PHASE: "phase-production-build" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldCheckEnv({ ...GOOD, SKIP_ENV_CHECK: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(findEnvProblems({} as NodeJS.ProcessEnv)).toHaveLength(4);
  });
});

describe("/api/ready", () => {
  it("200 cu replica + commit când DB și Redis răspund", async () => {
    vi.stubEnv("BUILD_COMMIT", "abc1234");
    vi.stubEnv("REPLICA_ID", "web-3");
    const res = await ready();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ready: true, draining: false, commit: "abc1234", replica: { id: "web-3" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    vi.unstubAllEnvs();
  });

  it("503 când Redis e jos sau neconfigurat", async () => {
    health.redis = { status: "error", latency_ms: 0, detail: {} };
    expect((await ready()).status).toBe(503);
    health.redis = { status: "degraded", latency_ms: 0, detail: { reason: "not_configured" } };
    expect((await ready()).status).toBe(503);
  });

  it("503 imediat după SIGTERM (draining), fără să mai lovească DB-ul", async () => {
    beginShutdown("SIGTERM");
    const res = await ready();
    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ database: "skipped", redis: "skipped" });
  });
});
