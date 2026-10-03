import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || "test-secret-key-for-gaming-tests";

let userId: string | null = "user-1";

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: () => new Response("frozen", { status: 410 }),
}));

vi.mock("@/lib/social/session", () => ({
  getAccountUserId: async () => userId,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
  getClientIP: () => "127.0.0.1",
}));

vi.mock("@/lib/db", async () => (await import("./helpers/gaming-fake-db")).dbModule);

import { fake } from "./helpers/gaming-fake-db";
import { xpDay } from "@/lib/gaming/level-math";
import { POST } from "@/app/api/gaming/score/route";
import { issueGamingToken } from "@/lib/gaming/tokens";

function req(body: unknown): Request {
  return new Request("http://localhost/api/gaming/score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let sessionSeq = 0;
function queueSession(msAgo: number) {
  fake.sessions.push({ id: `sess-${++sessionSeq}`, started_at: new Date(Date.now() - msAgo).toISOString() });
}

beforeEach(() => {
  userId = "user-1";
  fake.reset();
});

describe("POST /api/gaming/score", () => {
  it("rejects when no sessionToken is present", async () => {
    const res = await POST(req({ gameId: "game_2048", score: 100 }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_payload");
  });

  it("rejects an unauthenticated request", async () => {
    userId = null;
    const res = await POST(req({ gameId: "game_2048", score: 100, sessionToken: "x" }) as any);
    expect(res.status).toBe(401);
  });

  it("rejects a tampered/invalid session token", async () => {
    const res = await POST(req({ gameId: "game_2048", score: 100, sessionToken: "not-a-real-token" }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_session_token");
  });

  it("rejects a token issued for a different user", async () => {
    const token = issueGamingToken("session", "someone-else", "game_2048", 600);
    const res = await POST(req({ gameId: "game_2048", score: 100, sessionToken: token }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_session_token");
  });

  it("rejects a reused/expired session row (DB says already used)", async () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    // no queued session row = UPDATE finds no matching unused row
    const res = await POST(req({ gameId: "game_2048", score: 100, sessionToken: token }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("session_token_reused_or_expired");
  });

  it("rejects a submission that is too fast for the game's min duration", async () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    queueSession(100); // 100ms ago, cap is 8000ms
    const res = await POST(req({ gameId: "game_2048", score: 100, sessionToken: token }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("too_fast");
  });

  it("rejects a score above the plausible cap", async () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    queueSession(20_000);
    const res = await POST(req({ gameId: "game_2048", score: 999_999_999, sessionToken: token }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("score_over_cap");
  });

  it("accepts a plausible score and awards XP", async () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    queueSession(20_000);
    const res = await POST(req({ gameId: "game_2048", score: 500, sessionToken: token }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.earnedXp).toBeGreaterThan(0);
  });

  it("caps earned XP at the daily limit even for a big score", async () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    queueSession(20_000);
    fake.daily.set(`user-1|${xpDay()}`, 295); // 5 units of headroom left under the 300 cap
    const res = await POST(req({ gameId: "game_2048", score: 500, sessionToken: token }) as any);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.earnedXp).toBeLessThanOrEqual(5);
  });

  it("restart: every new session (replay after game over) scores and earns XP once", async () => {
    const first = issueGamingToken("session", "user-1", "game_2048", 600);
    queueSession(20_000);
    const r1 = await (await POST(req({ gameId: "game_2048", score: 500, sessionToken: first }) as any)).json();

    const second = issueGamingToken("session", "user-1", "game_2048", 600);
    queueSession(20_000);
    const r2 = await (await POST(req({ gameId: "game_2048", score: 500, sessionToken: second }) as any)).json();

    expect(r1.earnedXp).toBeGreaterThan(0);
    expect(r2.earnedXp).toBe(r1.earnedXp);
    expect(fake.profiles.get("user-1")?.xp).toBe(r1.earnedXp + r2.earnedXp);
    expect(fake.scores).toHaveLength(2);
  });
});
