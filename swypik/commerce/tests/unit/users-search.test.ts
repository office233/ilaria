import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedParams: unknown[] = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (_sql: string, params: unknown[] = []) => {
    capturedParams = params;
    return {
      rows: [
        {
          id: "user-2",
          username: "maria_style",
          display_name: "Maria",
          avatar_url: "https://example.com/a.png",
          // Fields that must never leak even if a future query joins them in.
          email: "maria@example.com",
          phone: "+40700000000",
        },
      ],
      rowCount: 1,
    };
  }),
}));

import { searchUsers } from "@/lib/users/search";

beforeEach(() => {
  capturedParams = [];
});

describe("users/search", () => {
  it("returns [] without querying the DB for a too-short query", async () => {
    const { dbQuery } = await import("@/lib/db");
    const results = await searchUsers("viewer-1", "a");
    expect(results).toEqual([]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("never returns email or phone, only id/username/display_name/avatar_url", async () => {
    const results = await searchUsers("viewer-1", "maria");
    expect(results).toEqual([
      { id: "user-2", username: "maria_style", display_name: "Maria", avatar_url: "https://example.com/a.png" },
    ]);
    for (const r of results) {
      expect(r).not.toHaveProperty("email");
      expect(r).not.toHaveProperty("phone");
    }
  });

  it("escapes ILIKE wildcards in the query before building the pattern", async () => {
    await searchUsers("viewer-1", "50%_off\\");
    const pattern = capturedParams[1] as string;
    expect(pattern).toBe("50\\%\\_off\\\\%");
  });

  it("excludes the viewer themselves via the id <> $1 clause", async () => {
    await searchUsers("viewer-1", "maria");
    expect(capturedParams[0]).toBe("viewer-1");
  });
});
