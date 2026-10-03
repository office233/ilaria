import { describe, it, expect, vi, beforeEach } from "vitest";

let userId: string | null = "user-1";
const flags = vi.hoisted(() => ({ gaming: true }));

vi.mock("@/lib/db", async () => (await import("./helpers/gaming-fake-db")).dbModule);
vi.mock("@/lib/feature-flags", () => ({
  isEnabled: (name: string) => (name === "gaming" ? flags.gaming : true),
  frozenResponse: () => new Response("frozen", { status: 410 }),
}));
vi.mock("@/lib/social/session", () => ({ getAccountUserId: async () => userId }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 10 }) }));

import { fake } from "./helpers/gaming-fake-db";
import { awardXp } from "@/lib/gaming/xp";
import { awardMilestoneXp, syncActivityXp, pendingActivityGrants } from "@/lib/gaming/activity-xp";
import { xpDay } from "@/lib/gaming/level-math";
import { DAILY_XP_CAP, XP_RULES } from "@/lib/gaming/config";
import { GET as profileGET } from "@/app/api/gaming/profile/route";

beforeEach(() => {
  userId = "user-1";
  flags.gaming = true;
  fake.reset();
});

describe("awardXp — idempotent ledger", () => {
  it("grants once per (user, action, ref); a retry grants nothing", async () => {
    const a = await awardXp("user-1", "first_purchase", "once", 100);
    const b = await awardXp("user-1", "first_purchase", "once", 100);
    expect(a).toEqual({ awarded: 100, duplicate: false, totalXp: 100 });
    expect(b).toEqual({ awarded: 0, duplicate: true, totalXp: null });
    expect(fake.profiles.get("user-1")?.xp).toBe(100);
  });

  it("concurrent duplicate calls still grant exactly once", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => awardXp("user-1", "trivia_daily", "2026-09-26", 40)));
    expect(results.filter((r) => r.awarded > 0)).toHaveLength(1);
    expect(fake.profiles.get("user-1")?.xp).toBe(40);
  });

  it("different refs are independent (each arcade session counts)", async () => {
    await awardXp("user-1", "arcade_round", "sess-1", 20);
    await awardXp("user-1", "arcade_round", "sess-2", 20);
    expect(fake.profiles.get("user-1")?.xp).toBe(40);
  });

  it("repeatable actions respect the daily cap; milestones don't", async () => {
    fake.daily.set(`user-1|${xpDay()}`, DAILY_XP_CAP - 5);
    const capped = await awardXp("user-1", "arcade_round", "sess-1", 50);
    expect(capped.awarded).toBe(5);
    const zero = await awardXp("user-1", "watch_daily", xpDay(), 15);
    expect(zero.awarded).toBe(0);
    const milestone = await awardXp("user-1", "first_upload", "once", 100);
    expect(milestone.awarded).toBe(100);
  });

  it("keeps the stored level in sync with the level module", async () => {
    await awardXp("user-1", "first_upload", "once", 100);
    await awardXp("user-1", "first_purchase", "once", 300);
    expect(fake.profiles.get("user-1")).toMatchObject({ xp: 400, level: 3 });
  });

  it("ignores negative / NaN amounts", async () => {
    const r = await awardXp("user-1", "arcade_round", "sess-x", Number.NaN);
    expect(r.awarded).toBe(0);
    expect(fake.profiles.has("user-1")).toBe(false);
  });
});

describe("XP for real actions (watching, first upload, first purchase)", () => {
  it("pendingActivityGrants: watch_daily only when today's views justify it and the ledger lacks it", () => {
    const day = "2026-09-26";
    const facts = { views_today: XP_RULES.watchDaily.minViews };
    expect(pendingActivityGrants(facts, new Set(), day).map((g) => g.action)).toEqual(["watch_daily"]);
    expect(pendingActivityGrants(facts, new Set([`watch_daily:${day}`]), day)).toEqual([]);
    expect(pendingActivityGrants({ views_today: 1 }, new Set(), day)).toEqual([]);
  });

  it("syncActivityXp is idempotent across calls (watch_daily only — milestones come from hooks)", async () => {
    fake.activity = { views_today: 10 };
    const first = await syncActivityXp("user-1");
    const second = await syncActivityXp("user-1");
    expect(first).toBe(XP_RULES.watchDaily.xp);
    expect(second).toBe(0);
    expect(fake.ledger.has("user-1|first_upload|once")).toBe(false);
  });

  it("a DB failure never breaks the caller", async () => {
    fake.failFor = /views_today/;
    await expect(syncActivityXp("user-1")).resolves.toBe(0);
  });

  it("awardMilestoneXp grants each milestone exactly once", async () => {
    expect(await awardMilestoneXp("user-1", "first_upload")).toBe(XP_RULES.firstUpload.xp);
    expect(await awardMilestoneXp("user-1", "first_upload")).toBe(0);
    expect(await awardMilestoneXp("user-1", "first_purchase")).toBe(XP_RULES.firstPurchase.xp);
    expect(fake.profiles.get("user-1")?.xp).toBe(XP_RULES.firstUpload.xp + XP_RULES.firstPurchase.xp);
  });

  it("awardMilestoneXp is a no-op when gaming is off, without a user, or on DB failure", async () => {
    flags.gaming = false;
    expect(await awardMilestoneXp("user-1", "first_upload")).toBe(0);
    flags.gaming = true;
    expect(await awardMilestoneXp(null, "first_upload")).toBe(0);
    expect(fake.ledger.size).toBe(0);
    fake.failFor = /gaming_xp_events/;
    await expect(awardMilestoneXp("user-1", "first_purchase")).resolves.toBe(0);
  });

  it("GET /api/gaming/profile reconciles watching and returns level badge data", async () => {
    await awardMilestoneXp("user-1", "first_purchase");
    fake.activity = { views_today: 0 };
    const json = await (await profileGET()).json();
    expect(json).toMatchObject({ ok: true, level: 2, xp: 100, syncedXp: 0, nextLevelXp: 400 });
  });

  it("GET /api/gaming/profile requires an account (no guest rows)", async () => {
    userId = null;
    const res = await profileGET();
    expect(res.status).toBe(401);
    expect(fake.ledger.size).toBe(0);
  });
});
