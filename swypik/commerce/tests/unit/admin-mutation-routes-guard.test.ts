/**
 * Plasă de siguranță pentru TOATE rutele de admin care modifică date
 * (POST/PATCH/PUT/DELETE sub app/api/admin):
 *   1. fără sesiune de admin → 401/403 (sau 410 pentru modulele înghețate),
 *      fără nicio scriere în DB și fără rând de audit;
 *   2. fiecare rută scrie în jurnalul de audit (logAdminAction, direct sau
 *      prin handler-ul comun de moderare).
 * O rută nouă fără gardă sau fără audit pică aici.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ writes: [] as string[] }));

function record(sql: unknown) {
  if (/^\s*(INSERT|UPDATE|DELETE|BEGIN)/i.test(String(sql))) h.writes.push(String(sql));
  return { rows: [], rowCount: 0 };
}

vi.mock("@/lib/db", () => {
  const q = vi.fn(async (sql: string) => record(sql));
  return {
    dbQuery: q,
    dbQueryLong: q,
    getDb: () => ({ connect: async () => ({ query: q, release: () => undefined }), query: q }),
    getPool: () => ({ connect: async () => ({ query: q, release: () => undefined }), query: q }),
    withTransaction: async (fn: (x: typeof q) => unknown) => fn(q),
    withAdvisoryLock: async (_k: string, fn: () => unknown) => fn(),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

const ROOT = path.resolve(__dirname, "../..");
const ADMIN_API = path.join(ROOT, "app/api/admin");
const MUTATING = ["POST", "PATCH", "PUT", "DELETE"] as const;
/** Autentificarea însăși — testate separat în admin-login-route.test.ts. */
const AUTH_ROUTES = new Set(["login", "logout"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : name === "route.ts" ? [full] : [];
  });
}

type RouteCase = { rel: string; file: string; methods: string[]; params: Record<string, string> };

const routes: RouteCase[] = walk(ADMIN_API)
  .map((file) => {
    const src = readFileSync(file, "utf8");
    const methods = MUTATING.filter((m) =>
      new RegExp(`export\\s+(async\\s+function|const)\\s+${m}\\b`).test(src),
    );
    const rel = path.relative(ADMIN_API, path.dirname(file)).split(path.sep).join("/");
    const params = Object.fromEntries(
      [...rel.matchAll(/\[([^\]]+)\]/g)].map((m) => [m[1], "11111111-1111-4111-8111-111111111111"]),
    );
    return { rel, file, methods: [...methods], params };
  })
  .filter((r) => r.methods.length > 0);

describe("admin mutation routes", () => {
  it("discovers the admin mutation routes", () => {
    expect(routes.length).toBeGreaterThan(30);
  });

  it.each(routes.map((r) => [r.rel, r] as const))("%s writes to the audit log", (_rel, r) => {
    const src = readFileSync(r.file, "utf8");
    expect(/logAdminAction|reportActionRoute/.test(src)).toBe(true);
  });

  const guarded = routes.filter((r) => !AUTH_ROUTES.has(r.rel));
  it.each(guarded.flatMap((r) => r.methods.map((m) => [`${m} ${r.rel}`, r, m] as const)))(
    "%s rejects anonymous callers without writing",
    async (_label, r, method) => {
      h.writes = [];
      const mod = (await import(/* @vite-ignore */ r.file)) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
      const req = new Request(`http://localhost/api/admin/${r.rel}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", decision: "approve", reason: "x", note: "x" }),
      });
      const res = await mod[method](req, { params: Promise.resolve(r.params) });
      expect([401, 403, 410]).toContain(res.status);
      expect(h.writes).toEqual([]);
    },
    60_000, // primul import (la rece) al unei rute încarcă multe module
  );
});
