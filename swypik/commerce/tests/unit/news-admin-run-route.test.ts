import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

let isAdmin = true;
let limited = false;
const pending: Promise<unknown>[] = [];
const queries: Array<{ sql: string; params: unknown[] }> = [];
const pipeline = vi.fn(async () => ({ ingested: 3, status: "published", categoriesProcessed: [], capped: false, duplicates: 0, errors: 0, sources: 2, errorSamples: [] }));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  // `after` rulează după răspuns; în test îl colectăm ca să verificăm că NU e așteptat înainte de 202.
  return { ...actual, after: (fn: () => Promise<unknown>) => { pending.push(Promise.resolve().then(fn)); } };
});
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response(null, { status: 410 }) }));
vi.mock("@/lib/admin/guard", () => ({
  requireAdmin: async () => (isAdmin ? { userId: "admin-1", role: "owner", kind: "admin_user" } : NextResponse.json({ error: "forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: async () => undefined }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: !limited, remaining: 0 }) }));
vi.mock("@/lib/prewarm/news", () => ({ refreshNewsLists: async () => 0 }));
vi.mock("@/lib/news/rss-ingester", () => ({ runNewsIngestionPipeline: () => pipeline() }));
vi.mock("@/lib/cron/lock", () => ({
  cronLockKey: (j: string) => `cron:${j}`,
  withAdvisoryLock: async (_k: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO cron_runs") && sql.includes("'running'")) return { rows: [{ id: "42" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
}));

import { POST } from "@/app/api/admin/news/run/route";

const call = () => POST(new Request("http://x/api/admin/news/run", { method: "POST", body: "{}" }));

beforeEach(() => {
  isAdmin = true;
  limited = false;
  pending.length = 0;
  queries.length = 0;
  pipeline.mockClear();
});

describe("POST /api/admin/news/run — rulare în fundal (fără 524 la Cloudflare)", () => {
  it("răspunde 202 cu runId imediat, apoi rulează și finalizează rândul din cron_runs", async () => {
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "42", status: "running" });
    expect(queries[0].sql).toContain("'running'");
    await Promise.all(pending);
    expect(pipeline).toHaveBeenCalledTimes(1);
    const done = queries.find((q) => q.sql.startsWith("UPDATE cron_runs"));
    expect(done?.params[0]).toBe("success");
    expect(done?.params[4]).toBe("42");
  });

  it("doar admin (content) și cu rate limit", async () => {
    isAdmin = false;
    expect((await call()).status).toBe(403);
    isAdmin = true;
    limited = true;
    expect((await call()).status).toBe(429);
    expect(pending).toHaveLength(0);
  });
});
