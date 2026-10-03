import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 2026-09-26 (w1-removals-data): transformarea produselor nu mai inventează
 * câmpuri — nici „viewers/cartAdds”, nici beneficii generice („Livrare rapida in
 * Romania”, „Produs verificat”), nici 7 zile de livrare implicite, nici rating
 * din metadata (seed-ul Fly avea 4.9). Rating-ul vine DOAR din product_reviews.
 */

const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

const seededRow = {
  id: PRODUCT_ID,
  title: "Zbor spre Paris",
  description: "Preț de la, dus, taxe incluse",
  price_cents: 16900,
  compare_at_price_cents: null,
  image_url: "https://example.test/paris.jpg",
  taxonomy_node_slug: null,
  metadata: { vertical: "fly", fly_iata: "CDG", rating: 4.9, cta_url: "/fly?dest=CDG" },
};

const dbQueryMock = vi.fn(async (sql: string) => {
  if (sql.includes("WHERE p.id::text = $1")) return { rows: [seededRow], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});
vi.mock("@/lib/db", () => ({ dbQuery: (sql: string) => dbQueryMock(sql) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

let reviewAgg: { productId: string; avgRating: number; reviewCount: number } | null = null;
vi.mock("@/lib/reviews/aggregate", () => ({
  getProductRatingMap: async (ids: string[]) =>
    new Map(reviewAgg && ids.includes(reviewAgg.productId) ? [[reviewAgg.productId, reviewAgg]] : []),
}));

import { getProductById } from "@/lib/db/product-queries";

beforeEach(() => {
  reviewAgg = null;
  dbQueryMock.mockClear();
});

describe("product transform — no fabricated fields", () => {
  it("drops fake social proof, benefits, delivery days and the metadata rating", async () => {
    const p = await getProductById(PRODUCT_ID);
    expect(p).not.toBeNull();
    const product = p as Record<string, unknown>;
    expect(product).not.toHaveProperty("viewers");
    expect(product).not.toHaveProperty("cartAdds");
    expect(product.benefits).toEqual([]);
    expect(product.deliveryDays).toBe(0);
    expect(product.rating).toBe(0);
    expect(product.commerceBadge).toBeUndefined();
  });

  it("uses the real review aggregate when reviews exist", async () => {
    reviewAgg = { productId: PRODUCT_ID, avgRating: 4.26, reviewCount: 3 };
    const p = await getProductById(PRODUCT_ID);
    expect(p?.rating).toBe(4.3);
  });
});
