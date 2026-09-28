import { describe, it, expect, vi, beforeEach } from "vitest";

// Catalog: cursor (keyset) stabil, listări/verticale excluse, categoriile
// codate în URL (department%3Aother) găsite corect.

const queries: Array<{ sql: string; params: unknown[] }> = [];
let rows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return { rows, rowCount: rows.length };
  }),
}));
vi.mock("@/lib/reviews/aggregate", () => ({ getProductRatingMap: vi.fn(async () => new Map()) }));

import { decodeCursor, encodeCursor, listCatalog } from "@/lib/shop/catalog";
import { decodeCategorySlug, findCategoryPath, parseCatalogSort } from "@/lib/shop/categories";

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const row = (n: number, key: number) => ({
  id: ID(n),
  title: `P${n}`,
  price_cents: 1000 + n,
  compare_at_price_cents: null,
  currency: "RON",
  image_url: null,
  has_video: false,
  sort_key: String(key),
});

beforeEach(() => {
  queries.length = 0;
  rows = [];
});

describe("catalog cursor", () => {
  it("round-trips and rejects tampered cursors", () => {
    const c = encodeCursor({ k: 1727000000123, id: ID(1) });
    expect(decodeCursor(c)).toEqual({ k: 1727000000123, id: ID(1) });
    expect(decodeCursor("not-base64-json")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ k: 1, id: "1; DROP TABLE" })).toString("base64url"))).toBeNull();
  });

  it("returns nextCursor from the last row and fetches limit+1", async () => {
    rows = [row(1, 300), row(2, 200), row(3, 100)];
    const page = await listCatalog({ sort: "newest", limit: 2, locale: "ro" });
    expect(page.items.map((i) => i.id)).toEqual([ID(1), ID(2)]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ k: 200, id: ID(2) });
    const main = queries.find((q) => q.sql.includes("FROM marketplace_products p"))!;
    expect(main.params[main.params.length - 1]).toBe(3);
    expect(main.sql).toContain("listing_type, 'product') = 'product'");
    expect(main.sql).toContain("NOT IN ('fly', 'go')");
  });

  it("applies the cursor with the sort direction", async () => {
    rows = [row(4, 50)];
    await listCatalog({ sort: "price_asc", cursor: encodeCursor({ k: 1500, id: ID(9) }), locale: "ro" });
    const main = queries.find((q) => q.sql.includes("FROM marketplace_products p"))!;
    expect(main.sql).toMatch(/\(s\.sort_key, s\.id\) > \(\$\d+::numeric, \$\d+::uuid\)/);
    expect(main.params).toContain(1500);
    expect(main.params).toContain(ID(9));
  });

  it("no next cursor on the last page", async () => {
    rows = [row(1, 10)];
    const page = await listCatalog({ sort: "newest", limit: 5, locale: "ro" });
    expect(page.nextCursor).toBeNull();
  });
});

describe("categories helpers", () => {
  const tree = [{ id: "fashion", name: "Modă", children: [{ id: "department:other", name: "Altele" }] }];
  it("decodes encoded slugs and finds the path", () => {
    const slug = decodeCategorySlug("department%3Aother");
    expect(findCategoryPath(tree, slug)?.map((n) => n.id)).toEqual(["fashion", "department:other"]);
    expect(findCategoryPath(tree, "missing")).toBeNull();
  });
  it("whitelists sort values", () => {
    expect(parseCatalogSort("price_desc")).toBe("price_desc");
    expect(parseCatalogSort("x; drop")).toBe("newest");
    expect(parseCatalogSort(undefined)).toBe("newest");
  });
});
