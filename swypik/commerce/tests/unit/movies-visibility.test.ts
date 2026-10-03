import { describe, it, expect, vi } from "vitest";

const sqls: string[] = [];
vi.mock("@/lib/db", () => ({
  dbQuery: async (sql: string) => {
    sqls.push(sql);
    return { rows: [], rowCount: 0 };
  },
  withTransaction: vi.fn(),
  withAdvisoryLock: vi.fn(),
}));

import { privatizeExpiredMovieTitles, targetVisibility } from "@/lib/movies/visibility";

describe("movies/visibility", () => {
  const published = { free_episodes: 3, status: "published" as const };
  it("episoadele gratuite ale unui serial publicat sunt public; restul private", () => {
    expect(targetVisibility(published, { episode_number: 1, status: "published" })).toBe("public");
    expect(targetVisibility(published, { episode_number: 3, status: "published" })).toBe("public");
    expect(targetVisibility(published, { episode_number: 4, status: "published" })).toBe("private");
  });
  it("orice episod nepublicat sau dintr-un serial nepublicat este private", () => {
    expect(targetVisibility(published, { episode_number: 1, status: "draft" })).toBe("private");
    expect(targetVisibility({ free_episodes: 3, status: "draft" }, { episode_number: 1, status: "published" })).toBe("private");
  });
  it("jobul de expirare a licenței folosește literale SQL citate (nu identificatori)", async () => {
    await privatizeExpiredMovieTitles();
    const q = sqls.find((x) => x.includes("license_expires_at <= now()"))!;
    expect(q).toContain("s.status = 'published'");
    expect(q).toContain("v.visibility = 'public'");
    expect(q).not.toMatch(/=\s*published[^']/);
    expect(q).not.toMatch(/=\s*public[^']/);
  });
});
