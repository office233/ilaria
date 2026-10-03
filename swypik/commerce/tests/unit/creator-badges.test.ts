import { describe, expect, it } from "vitest";
import { getCreatorBadges, levelFromGmv } from "@/lib/social/creator-badges";

function fakeQuery(gmvCents: number | string | null) {
  return async () => ({ rows: [{ gmv_cents: gmvCents }], rowCount: 1 });
}

describe("levelFromGmv", () => {
  it("returns none under the bronze threshold", () => {
    expect(levelFromGmv(0)).toBe("none");
    expect(levelFromGmv(9_999)).toBe("none");
  });

  it("maps thresholds to levels", () => {
    expect(levelFromGmv(10_000)).toBe("bronze");
    expect(levelFromGmv(99_999)).toBe("bronze");
    expect(levelFromGmv(100_000)).toBe("silver");
    expect(levelFromGmv(999_999)).toBe("silver");
    expect(levelFromGmv(1_000_000)).toBe("gold");
    expect(levelFromGmv(50_000_000)).toBe("gold");
  });
});

describe("getCreatorBadges", () => {
  it("computes gold + top seller for high GMV", async () => {
    const badges = await getCreatorBadges("u1", {
      verified: true,
      query: fakeQuery("3000000") as never,
    });
    expect(badges).toEqual({
      verified: true,
      level: "gold",
      topSeller: true,
      gmvCents: 3_000_000,
    });
  });

  it("handles null/absent GMV safely", async () => {
    const badges = await getCreatorBadges("u2", { query: fakeQuery(null) as never });
    expect(badges.gmvCents).toBe(0);
    expect(badges.level).toBe("none");
    expect(badges.topSeller).toBe(false);
    expect(badges.verified).toBe(false);
  });
});
