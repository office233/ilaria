import { describe, it, expect } from "vitest";

describe("Seller ERP - POS Casă de Marcat & Stocuri", () => {
  it("calculează corect totalul bonului și restul de dat pentru numerar", () => {
    const cart = [
      { id: "p1", title: "Produs A", priceCents: 2500, quantity: 2 }, // 50.00 RON
      { id: "p2", title: "Produs B", priceCents: 1550, quantity: 1 }, // 15.50 RON
    ];

    const totalCents = cart.reduce((acc, item) => acc + item.priceCents * item.quantity, 0);
    const totalRon = totalCents / 100;
    expect(totalRon).toBe(65.5);

    const cashGiven = 100.0;
    const changeRon = Math.max(0, cashGiven - totalRon);
    expect(changeRon).toBe(34.5);
  });

  it("actualizează stocul și setează statusul out_of_stock când stocul atinge 0", () => {
    const updateInventory = (currentStock: number, quantitySold: number) => {
      const newStock = Math.max(0, currentStock - quantitySold);
      const status = newStock > 0 ? "in_stock" : "out_of_stock";
      return { newStock, status };
    };

    // Vânzare parțială
    const res1 = updateInventory(10, 3);
    expect(res1.newStock).toBe(7);
    expect(res1.status).toBe("in_stock");

    // Vânzare totală
    const res2 = updateInventory(5, 5);
    expect(res2.newStock).toBe(0);
    expect(res2.status).toBe("out_of_stock");

    // Vânzare peste stocul disponibil (nu coboară sub 0)
    const res3 = updateInventory(2, 5);
    expect(res3.newStock).toBe(0);
    expect(res3.status).toBe("out_of_stock");
  });

  it("calculează corect baza impozabilă și TVA-ul de 21% pe bonul fiscal", () => {
    const totalRon = 121.0; // 121 lei total
    const tvaRon = totalRon - totalRon / 1.21;
    const subtotalRon = totalRon - tvaRon;

    expect(subtotalRon).toBeCloseTo(100.0, 2);
    expect(tvaRon).toBeCloseTo(21.0, 2);
    expect(subtotalRon + tvaRon).toBeCloseTo(totalRon, 2);
  });
});
