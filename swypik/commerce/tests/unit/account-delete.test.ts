import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const mocks = vi.hoisted(() => ({ db: vi.fn(), tx: vi.fn(), session: vi.fn(), limit: vi.fn(), mail: vi.fn() }));
vi.mock("@/lib/db", () => ({
  dbQuery: mocks.db,
  withTransaction: async (fn: (q: typeof mocks.tx) => unknown) => fn(mocks.tx),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: mocks.session }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: mocks.limit }));
vi.mock("@/lib/email/templates/auth", () => ({ sendAccountDeletedEmail: mocks.mail }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://swypik.com" }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/account/delete/route";

const req = (body: unknown) =>
  new Request("https://swypik.com/api/account/delete", { method: "POST", body: JSON.stringify(body), headers: { "accept-language": "en" } });

let hash = "";
beforeEach(async () => {
  vi.resetAllMocks();
  hash ||= await bcrypt.hash("secret123", 4);
  mocks.session.mockResolvedValue({ userId: "11111111-2222-3333-4444-555555555555" });
  mocks.limit.mockResolvedValue({ success: true });
  mocks.mail.mockResolvedValue(true);
  mocks.db.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT username, email, role, password_hash")) {
      return { rows: [{ username: "maria", email: "m@example.com", role: "creator", password_hash: hash }] };
    }
    return { rows: [] };
  });
  mocks.tx.mockImplementation(async (sql: string) => {
    if (sql.includes("FOR UPDATE")) return { rows: [{ email: "m@example.com", username: "maria", locale: "en" }] };
    return { rows: [] };
  });
});

describe("POST /api/account/delete", () => {
  it("requires a session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await POST(req({ confirm: "maria" }))).status).toBe(401);
  });

  it("requires the exact username and the password", async () => {
    expect((await POST(req({ confirm: "someone", password: "secret123" }))).status).toBe(400);
    expect((await POST(req({ confirm: "maria", password: "wrong" }))).status).toBe(403);
    expect(mocks.tx).not.toHaveBeenCalled();
  });

  it("anonymises the user, keeps the old username reserved, revokes sessions and clears cookies", async () => {
    const res = await POST(req({ confirm: "@Maria", password: "secret123" }));
    expect(res.status).toBe(200);
    const txSql = mocks.tx.mock.calls.map((c) => String(c[0]));
    expect(txSql.some((s) => s.includes("INSERT INTO username_aliases"))).toBe(true);
    const update = txSql.find((s) => s.includes("UPDATE users SET"));
    expect(update).toContain("email = NULL");
    expect(update).toContain("status = 'deleted'");
    expect(txSql.some((s) => s.includes("UPDATE user_sessions SET revoked_at"))).toBe(true);
    // Evidențele financiare nu se șterg.
    const all = mocks.db.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toMatch(/DELETE FROM commerce_orders|DELETE FROM payment|DELETE FROM commission/);
    expect(mocks.mail).toHaveBeenCalledWith("m@example.com", "en");
    expect(res.headers.get("set-cookie")).toContain("swypik_session=;");
  });

  it("refuses active sellers with a translated message", async () => {
    mocks.db.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT username, email, role, password_hash")) {
        return { rows: [{ username: "maria", email: "m@example.com", role: "creator", password_hash: hash }] };
      }
      if (sql.includes("FROM sellers")) return { rows: [{ ok: true }] };
      return { rows: [] };
    });
    const res = await POST(req({ confirm: "maria", password: "secret123" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/active seller account/);
  });
});
