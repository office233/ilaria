import { describe, expect, it, vi } from "vitest";

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery }));
vi.mock("@/lib/http/cache-policy", () => ({
  applyCachePolicy: (response: Response) => response,
}));

import { GET } from "@/app/api/videos/[id]/products/route";

describe("public video product overlay moderation gate", () => {
  it("uses the canonical effective_label=safe gate", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const id = "11111111-1111-4111-8111-111111111111";
    const res = await GET(
      new Request(`https://swypik.com/api/videos/${id}/products`),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const sql = String(dbQuery.mock.calls[0][0]);
    expect(sql).toContain("v.effective_label = 'safe'");
    expect(sql).not.toContain("moderation_status");
  });
});
