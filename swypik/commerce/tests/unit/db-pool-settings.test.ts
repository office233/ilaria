import { describe, it, expect } from "vitest";
import { poolSettingsFromEnv } from "@/lib/db";

const env = (over: Record<string, string>) => ({ NODE_ENV: "production", ...over }) as unknown as NodeJS.ProcessEnv;

describe("poolSettingsFromEnv — pool Postgres per replică", () => {
  it("implicit: 15 în producție, 5 în dev; idle 30 s", () => {
    expect(poolSettingsFromEnv(env({}))).toEqual({ max: 15, idleTimeoutMillis: 30_000 });
    expect(poolSettingsFromEnv(env({ NODE_ENV: "development" })).max).toBe(5);
  });

  it("PG_POOL_MAX / PG_IDLE_TIMEOUT_MS suprascriu, valorile absurde sunt ignorate", () => {
    expect(poolSettingsFromEnv(env({ PG_POOL_MAX: "30", PG_IDLE_TIMEOUT_MS: "60000" }))).toEqual({ max: 30, idleTimeoutMillis: 60_000 });
    expect(poolSettingsFromEnv(env({ PG_POOL_MAX: "0" })).max).toBe(15);
    expect(poolSettingsFromEnv(env({ PG_POOL_MAX: "5000" })).max).toBe(15);
    expect(poolSettingsFromEnv(env({ PG_POOL_MAX: "abc", PG_IDLE_TIMEOUT_MS: "10" })).idleTimeoutMillis).toBe(30_000);
  });
});
