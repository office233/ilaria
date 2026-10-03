import { describe, expect, it, vi } from "vitest";

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery }));

import { getImportedSalesStats } from "@/lib/seller/imports/analytics";

describe("getImportedSalesStats", () => {
  it("keeps currencies separate and converts bigint strings to numbers", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [
        {
          currency: "EUR",
          sales_30: "12500",
          sales_prev_30: "10000",
          orders_30: 3,
          lifetime_sales: "50000",
          lifetime_orders: 12,
          refunded_lifetime: "2500",
        },
        {
          currency: "RON",
          sales_30: "99900",
          sales_prev_30: "0",
          orders_30: 7,
          lifetime_sales: "320000",
          lifetime_orders: 20,
          refunded_lifetime: "0",
        },
      ],
      rowCount: 2,
    });

    const stats = await getImportedSalesStats("seller-1");
    expect(stats).toEqual([
      {
        currency: "EUR",
        sales30Cents: 12500,
        salesPrev30Cents: 10000,
        orders30: 3,
        lifetimeSalesCents: 50000,
        lifetimeOrders: 12,
        refundedLifetimeCents: 2500,
      },
      {
        currency: "RON",
        sales30Cents: 99900,
        salesPrev30Cents: 0,
        orders30: 7,
        lifetimeSalesCents: 320000,
        lifetimeOrders: 20,
        refundedLifetimeCents: 0,
      },
    ]);
    expect(String(dbQuery.mock.calls[0][0])).toContain("GROUP BY currency");
  });
});
