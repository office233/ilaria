import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || "test-secret-key-for-gaming-tests";

const QUESTIONS = [
  { id: "q1", category: "Video Games", difficulty: "easy", question: "Q1?", options: ["A", "B"], correctAnswer: "A" },
  { id: "q2", category: "Video Games", difficulty: "easy", question: "Q2?", options: ["A", "B"], correctAnswer: "B" },
];

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

vi.mock("@/lib/gaming/opentdb", () => ({
  getDailyTriviaQuestions: async () => QUESTIONS,
  triviaLanguage: (l: string | null) => (l === "ro" ? "ro" : "en"),
}));

vi.mock("@/lib/db", async () => (await import("./helpers/gaming-fake-db")).dbModule);

import { fake } from "./helpers/gaming-fake-db";
import { xpDay } from "@/lib/gaming/level-math";
import { TRIVIA_GAME_ID } from "@/lib/gaming/config";
import { POST } from "@/app/api/gaming/trivia/answer/route";
import { issueGamingToken } from "@/lib/gaming/tokens";

function req(body: unknown): Request {
  return new Request("http://localhost/api/gaming/trivia/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  userId = "user-1";
  fake.reset();
  fake.rounds.push({ id: "round-1", questions: QUESTIONS });
});

describe("POST /api/gaming/trivia/answer", () => {
  it("grades correctly and computes score server-side", async () => {
    const token = issueGamingToken("trivia", "user-1", "round-1", 600);
    const res = await POST(
      req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }, { questionId: "q2", answer: "A" }] }) as any,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.correctCount).toBe(1); // q1 correct, q2 wrong
    expect(json.score).toBe(50);
    expect(json.results.find((r: any) => r.questionId === "q2").correctAnswer).toBe("B");
  });

  it("rejects a tampered round token", async () => {
    const token = issueGamingToken("trivia", "user-1", "round-1", 600);
    const tampered = token.slice(0, -2) + "zz";
    const res = await POST(req({ roundToken: tampered, answers: [{ questionId: "q1", answer: "A" }] }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_round_token");
  });

  it("rejects an expired round token", async () => {
    const token = issueGamingToken("trivia", "user-1", "round-1", -1);
    const res = await POST(req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }] }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_round_token");
  });

  it("rejects reuse of an already-answered round", async () => {
    const token = issueGamingToken("trivia", "user-1", "round-1", 600);
    const first = await POST(req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }] }) as any);
    expect(first.status).toBe(200);

    // Second submission with the same token: DB row is now consumed.
    const second = await POST(req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }] }) as any);
    expect(second.status).toBe(400);
    const json = await second.json();
    expect(json.error).toBe("round_token_reused_or_expired");
  });

  it("rejects a token belonging to another user", async () => {
    const token = issueGamingToken("trivia", "someone-else", "round-1", 600);
    const res = await POST(req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }] }) as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_round_token");
  });

  it("caps earned XP at the daily limit", async () => {
    fake.daily.set(`user-1|${xpDay()}`, 295);
    const token = issueGamingToken("trivia", "user-1", "round-1", 600);
    const res = await POST(
      req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }, { questionId: "q2", answer: "B" }] }) as any,
    );
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.correctCount).toBe(2);
    expect(json.earnedXp).toBeLessThanOrEqual(5);
  });

  it("records the score against the trivia_daily system game (FK fix)", async () => {
    const token = issueGamingToken("trivia", "user-1", "round-1", 600);
    const res = await POST(req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }] }) as any);
    expect(res.status).toBe(200);
    expect(fake.scores).toHaveLength(1);
    expect(fake.scores[0][1]).toBe(TRIVIA_GAME_ID);
  });
});

describe("daily trivia", () => {
  const answerAll = (roundId: string) => {
    const token = issueGamingToken("trivia", "user-1", roundId, 600);
    return POST(req({ roundToken: token, answers: [{ questionId: "q1", answer: "A" }, { questionId: "q2", answer: "B" }] }) as any);
  };

  it("first completed round of the day earns XP and starts the streak", async () => {
    const json = await (await answerAll("round-1")).json();
    expect(json.earnedXp).toBe(40); // 2 correct × 20
    expect(json.dailyXpAlreadyClaimed).toBe(false);
    expect(json.streakDays).toBe(1);
    expect(fake.profiles.get("user-1")?.xp).toBe(40);
  });

  it("a replay the same day is graded but earns no XP and doesn't move the streak", async () => {
    await answerAll("round-1");
    fake.rounds.push({ id: "round-2", questions: QUESTIONS });
    const json = await (await answerAll("round-2")).json();
    expect(json.ok).toBe(true);
    expect(json.correctCount).toBe(2);
    expect(json.earnedXp).toBe(0);
    expect(json.dailyXpAlreadyClaimed).toBe(true);
    expect(json.streakDays).toBeNull();
    expect(fake.profiles.get("user-1")?.xp).toBe(40);
  });

  it("continues the streak from yesterday", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    fake.profiles.set("user-1", { xp: 0, level: 1, streak: 4, lastDay: yesterday });
    const json = await (await answerAll("round-1")).json();
    expect(json.streakDays).toBe(5);
  });

  it("GET /api/gaming/trivia reports whether today's XP is still available", async () => {
    const { GET } = await import("@/app/api/gaming/trivia/route");
    const before = await (await GET(new Request("http://x/api/gaming/trivia?locale=en"))).json();
    expect(before.xpAvailableToday).toBe(true);
    expect(JSON.stringify(before.questions)).not.toContain("correctAnswer");
    await answerAll("round-1");
    const after = await (await GET(new Request("http://x/api/gaming/trivia?locale=en"))).json();
    expect(after.xpAvailableToday).toBe(false);
  });
});
