import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  limit: vi.fn(),
  magic: vi.fn(),
  verifyMail: vi.fn(),
  welcome: vi.fn(),
  reset: vi.fn(),
  configured: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ dbQuery: mocks.db }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/email/service", () => ({ sendMagicLink: mocks.magic }));
vi.mock("@/lib/email/templates/auth", () => ({
  sendVerifyEmail: mocks.verifyMail,
  sendWelcomeEmail: mocks.welcome,
  sendPasswordResetEmail: mocks.reset,
}));
vi.mock("@/lib/email/transport", () => ({ emailConfigured: mocks.configured }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: mocks.limit, getClientIP: () => "ip" }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn() }), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/referral/attribution", () => ({ attributeOnSignup: vi.fn() }));
vi.mock("@/lib/risk/recreation-detection", () => ({ checkRecreationAndMaybeBlock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ hashSessionToken: (t: string) => `h:${t}`, resolvePostLoginRedirect: () => "/account" }));
vi.mock("@/lib/security/admin-auth", () => ({
  createAdminSessionAndGetCookie: vi.fn(),
  revokeAdminSessionsForUser: vi.fn(),
  getAdminCookieName: () => "admin_session",
}));
vi.mock("@/lib/cart/session", () => ({ CART_COOKIE: "cart", mergeAnonCartToUser: vi.fn() }));
vi.mock("@/lib/social/session", () => ({ getAnonShellUserId: vi.fn() }));
vi.mock("@/lib/social/merge-anon", () => ({ mergeAnonSocialToUser: vi.fn() }));
vi.mock("@/lib/app-url", () => ({ APP_URL: "https://swypik.com" }));

import { POST } from "@/app/api/auth/route";

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new Request("https://swypik.com/api/auth", { method: "POST", headers, body: JSON.stringify(body) }));

type Rule = [needle: string, rows: unknown[] | Error];
function db(rules: Rule[]) {
  mocks.db.mockImplementation(async (sql: string) => {
    for (const [needle, rows] of rules) {
      if (sql.includes(needle)) {
        if (rows instanceof Error) throw rows;
        return { rows };
      }
    }
    return { rows: [] };
  });
}
const sqls = () => mocks.db.mock.calls.map((c) => String(c[0]));

const signup = {
  action: "signup_password",
  email: "new@example.com",
  password: "secret123",
  first_name: "Maria",
  last_name: "Pop",
  username: "maria_pop",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.limit.mockResolvedValue({ success: true });
  mocks.magic.mockResolvedValue(true);
  mocks.verifyMail.mockResolvedValue(true);
  mocks.welcome.mockResolvedValue(true);
  mocks.configured.mockReturnValue(true);
  db([]);
});

describe("usernames on password signup", () => {
  it("check_username reports reserved names", async () => {
    const res = await post({ action: "check_username", username: "admin" });
    const j = await res.json();
    expect(j.available).toBe(false);
    expect(j.reason).toBe("username_reserved");
  });

  it("check_username treats another account's old alias as taken", async () => {
    db([["username_aliases", [{ taken: true }]]]);
    const j = await (await post({ action: "check_username", username: "old_name" })).json();
    expect(j).toMatchObject({ available: false, reason: "username_taken" });
  });

  it("signup refuses reserved usernames with a translated error", async () => {
    const res = await post({ ...signup, username: "support" }, { "accept-language": "en-GB" });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j).toMatchObject({ success: false, code: "usernameReserved", field: "username" });
    expect(j.error).toBe("This username is reserved. Choose another one.");
    expect(sqls().some((s) => s.includes("INSERT INTO users"))).toBe(false);
  });

  it("a concurrent signup (unique violation) is a 409, not a 500", async () => {
    db([["INSERT INTO users", Object.assign(new Error("dup"), { code: "23505", constraint: "users_email_key" })]]);
    const res = await post(signup);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("emailTaken");
  });

  it("stores the real locale and sends ONE email: the verification link (no welcome yet)", async () => {
    db([["INSERT INTO users", [{ id: "u1" }]], ["FROM users WHERE id = $1", [{ id: "u1", email: "new@example.com", role: "creator" }]]]);
    const res = await post({ ...signup, locale: "de" });
    expect(res.status).toBe(200);
    const insert = mocks.db.mock.calls.find((c) => String(c[0]).includes("INSERT INTO users"));
    expect(insert?.[1]).toContain("de");
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.verifyMail).toHaveBeenCalledTimes(1);
    expect(mocks.verifyMail.mock.calls[0][2]).toBe("de");
    expect(mocks.welcome).not.toHaveBeenCalled();
    expect(mocks.magic).not.toHaveBeenCalled();
  });
});

describe("login by email code", () => {
  it("does NOT create an account for an unknown email before verification", async () => {
    const res = await post({ action: "login", email: "stranger@example.com", locale: "it" });
    expect(res.status).toBe(200);
    expect(sqls().some((s) => s.includes("INSERT INTO users"))).toBe(false);
    const pending = mocks.db.mock.calls.find((c) => String(c[0]).includes("INSERT INTO pending_signups"));
    expect(pending?.[1]).toContain("it");
    expect(mocks.magic).toHaveBeenCalledWith("stranger@example.com", expect.stringMatching(/^\d{6}$/), "it");
  });

  it("says 'email not configured' instead of faking success when the key is a placeholder", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.configured.mockReturnValue(false);
    const res = await post({ action: "login", email: "someone@example.com" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("emailUnavailable");
    expect(mocks.magic).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("creates the account only when the pending code is verified", async () => {
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update("otp:123456").digest("hex");
    db([
      ["UPDATE pending_signups", [{ otp_hash: hash, attempts: 1 }]],
      ["DELETE FROM pending_signups", [{ locale: "es" }]],
      ["INSERT INTO users", [{ id: "u2" }]],
      ["SELECT status FROM users", [{ status: "active" }]],
      ["RETURNING email, first_name, locale", [{ email: "stranger@example.com", first_name: null, locale: "es" }]],
      ["FROM users WHERE id = $1", [{ id: "u2", email: "stranger@example.com", role: "creator" }]],
    ]);
    const res = await post({ action: "verify_otp", email: "stranger@example.com", token: "123456" });
    expect(res.status).toBe(200);
    const insert = mocks.db.mock.calls.find((c) => String(c[0]).includes("INSERT INTO users"));
    expect(insert?.[1]).toContain("es");
    expect(mocks.welcome).toHaveBeenCalledWith("stranger@example.com", null, "es");
  });

  it("a wrong pending code creates nothing", async () => {
    db([["UPDATE pending_signups", [{ otp_hash: "0".repeat(64), attempts: 1 }]]]);
    const res = await post({ action: "verify_otp", email: "stranger@example.com", token: "111111" });
    expect(res.status).toBe(400);
    expect(sqls().some((s) => s.includes("INSERT INTO users"))).toBe(false);
  });
});

describe("email verification link", () => {
  it("verify_email consumes the token and marks the email verified", async () => {
    db([
      ["UPDATE email_verification_tokens", [{ user_id: "u1" }]],
      ["RETURNING email, first_name, locale", [{ email: "a@example.com", first_name: "Ana", locale: "ro" }]],
    ]);
    const res = await post({ action: "verify_email", token: "x".repeat(43) });
    expect(res.status).toBe(200);
    expect(mocks.welcome).toHaveBeenCalledWith("a@example.com", "Ana", "ro");
  });

  it("verify_email rejects an unknown token", async () => {
    const res = await post({ action: "verify_email", token: "y".repeat(43) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("tokenInvalid");
  });
});
