import { describe, it, expect } from "vitest";
import { SellerProductCreateSchema, parseBody } from "@/lib/validation/schemas";

describe("Seller ERP - Dual Media & Canal Swypik Shop", () => {
  it("validează cu succes un produs cu poze multiple, clip video 9:16 și cod de bare", () => {
    const validPayload = {
      title: "Suport Auto MagSafe 15W Wireless Fast Charge",
      description: "Produs testat cu prindere magnetică fermă",
      brand: "Swypik Auto",
      sku: "MAG-001",
      barcode: "5949012300018",
      price: 59.9,
      compare_at_price: 89.9,
      supplier_cost: 22.0,
      currency: "RON",
      stock: 50,
      category: "Auto & Moto",
      image_urls: [
        "https://cdn.swypik.com/img1.jpg",
        "https://cdn.swypik.com/img2.jpg",
      ],
      video_url: "https://cdn.swypik.com/video_9_16.mp4",
      is_swypik_listed: true,
      swypik_price: 59.9,
    };

    const parsed = parseBody(SellerProductCreateSchema, validPayload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.barcode).toBe("5949012300018");
      expect(parsed.data.video_url).toBe("https://cdn.swypik.com/video_9_16.mp4");
      expect(parsed.data.image_urls).toHaveLength(2);
      expect(parsed.data.is_swypik_listed).toBe(true);
    }
  });

  it("calculează exact comisionul de 7% al platformei Swypik și venitul net al comerciantului", () => {
    const priceRon = 99.9;
    const commissionRate = 0.07;

    const commissionRon = Number((priceRon * commissionRate).toFixed(2));
    const netPayoutRon = Number((priceRon * (1 - commissionRate)).toFixed(2));

    expect(commissionRon).toBe(6.99);
    expect(netPayoutRon).toBe(92.91);
    expect(commissionRon + netPayoutRon).toBeCloseTo(priceRon, 2);
  });

  it("respinge produse cu mai mult de 8 imagini conform limitării platformei", () => {
    const invalidPayload = {
      title: "Produs Test Imagini",
      price: 10,
      stock: 5,
      image_urls: Array(9).fill("https://cdn.swypik.com/img.jpg"),
    };

    const parsed = parseBody(SellerProductCreateSchema, invalidPayload);
    expect(parsed.ok).toBe(false);
  });
});
