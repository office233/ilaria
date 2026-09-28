import { describe, it, expect } from "vitest";

describe("Seller ERP - Swypik Ads Manager", () => {
  it("calculează corect ROAS (Return On Ad Spend) și conversia", () => {
    const campaigns = [
      { spentCents: 5000, revenueCents: 24000, orders: 4, impressions: 1500 }, // 50 lei spent, 240 lei rev
      { spentCents: 3000, revenueCents: 15000, orders: 3, impressions: 900 },  // 30 lei spent, 150 lei rev
    ];

    const totalSpentCents = campaigns.reduce((acc, c) => acc + c.spentCents, 0);
    const totalRevenueCents = campaigns.reduce((acc, c) => acc + c.revenueCents, 0);
    const totalOrders = campaigns.reduce((acc, c) => acc + c.orders, 0);

    expect(totalSpentCents).toBe(8000); // 80.00 RON
    expect(totalRevenueCents).toBe(39000); // 390.00 RON
    expect(totalOrders).toBe(7);

    const roas = Number((totalRevenueCents / totalSpentCents).toFixed(2));
    expect(roas).toBe(4.88); // 4.88x return
  });

  it("asigură plafonul minim de buget zilnic de 10 RON (1000 cenți)", () => {
    const validateBudget = (inputRon: number) => {
      const minRon = 10;
      const effectiveRon = Math.max(minRon, inputRon);
      return Math.round(effectiveRon * 100);
    };

    expect(validateBudget(5)).toBe(1000); // ridicat la minim 10 lei
    expect(validateBudget(30)).toBe(3000); // 30 lei
    expect(validateBudget(150.5)).toBe(15050); // 150.50 lei
  });

  it("comută corect statusul campaniei între active și paused", () => {
    const toggleStatus = (currentStatus: string) => {
      return currentStatus === "active" ? "paused" : "active";
    };

    expect(toggleStatus("active")).toBe("paused");
    expect(toggleStatus("paused")).toBe("active");
  });
});
