import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Nivelul XP în antetul profilului public: doar cu FEATURE_GAMING pornit. */

const s = vi.hoisted(() => ({ gaming: true, queries: 0, fail: false }));

vi.mock("@/lib/feature-flags", () => ({ isEnabled: (name: string) => (name === "gaming" ? s.gaming : false) }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async () => {
    s.queries += 1;
    if (s.fail) throw new Error("relation gaming_user_profiles does not exist");
    return { rows: [{ user_id: "u1", xp_points: "450", trivia_streak_days: 2 }], rowCount: 1 };
  }),
}));

import { getProfileLevelBadge } from "@/lib/gaming/level";

beforeEach(() => {
  s.gaming = true;
  s.queries = 0;
  s.fail = false;
});

describe("getProfileLevelBadge", () => {
  it("flag ON → badge-ul calculat din XP", async () => {
    expect(await getProfileLevelBadge("u1")).toMatchObject({ level: 3, xp: 450, triviaStreakDays: 2 });
  });

  it("flag OFF → null, fără citire din DB", async () => {
    s.gaming = false;
    expect(await getProfileLevelBadge("u1")).toBeNull();
    expect(s.queries).toBe(0);
  });

  it("eroare DB → null (profilul nu cade)", async () => {
    s.fail = true;
    expect(await getProfileLevelBadge("u1")).toBeNull();
  });

  it("pagina de profil trimite nivelul în ProfileHeader, care randează LevelBadge", () => {
    const page = readFileSync(resolve(__dirname, "../../app/[locale]/u/[username]/page.tsx"), "utf8");
    const header = readFileSync(resolve(__dirname, "../../components/social/profile/ProfileHeader.tsx"), "utf8");
    expect(page).toContain("getProfileLevelBadge(profile.id)");
    expect(page).toContain("level={level}");
    expect(header).toContain("<LevelBadge badge={level} />");
  });
});
