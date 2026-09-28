import { describe, it, expect } from "vitest";
import {
  RO_VAT_STANDARD_PCT,
  RO_VAT_REDUCED_PCT,
  computeInvoiceTotals,
  formatInvoiceNumber,
  formatReceiptNumber,
  toCents,
  escapeXml,
} from "@/lib/seller/invoicing";

/**
 * Testele anterioare (16 sept 2026) copiau formula de TVA ÎN test și o verificau
 * pe ea însăși — nu atingeau codul din rută. Acum importă helper-ii reali.
 */
describe("Seller ERP — facturare", () => {
  const items = [
    { title: "Suport Auto MagSafe 15W", quantity: 2, price: 59.9 },
    { title: "Cablu USB-C Fast Charge", quantity: 1, price: 29.9 },
  ];

  it("extrage baza impozabilă și TVA-ul din prețuri cu TVA inclus, în cenți exacți (21% standard)", () => {
    const t = computeInvoiceTotals(items, RO_VAT_STANDARD_PCT);
    expect(t.totalCents).toBe(14970);
    expect(t.subtotalCents).toBe(12372);
    expect(t.vatCents).toBe(2598);
    expect(t.subtotalCents + t.vatCents).toBe(t.totalCents);
  });

  it("aplică cota redusă de 11%", () => {
    const t = computeInvoiceTotals(items, RO_VAT_REDUCED_PCT);
    expect(t.subtotalCents).toBe(13486);
    expect(t.vatCents).toBe(1484);
    expect(t.subtotalCents + t.vatCents).toBe(t.totalCents);
  });

  it("cota 0 înseamnă subtotal = total și TVA 0", () => {
    const t = computeInvoiceTotals(items, 0);
    expect(t.subtotalCents).toBe(14970);
    expect(t.vatCents).toBe(0);
  });

  it("cantitățile invalide sau lipsă se tratează ca 1, prețul lipsă ca 0", () => {
    const t = computeInvoiceTotals([{ title: "x", quantity: 0, price: 10 }, { title: "y", quantity: 3, price: NaN }], 21);
    expect(t.totalCents).toBe(1000);
  });

  it("toCents nu suferă de eroarea de virgulă mobilă", () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(59.9)).toBe(5990);
  });

  it("formatează numărul de factură per serie cu padding la 4 cifre", () => {
    expect(formatInvoiceNumber("FACT", 1)).toBe("FACT-0001");
    expect(formatInvoiceNumber(" FACT ", 42)).toBe("FACT-0042");
    expect(formatInvoiceNumber("SW-2026", 1250)).toBe("SW-2026-1250");
  });

  it("formatează numărul de bon POS cu data zilei", () => {
    expect(formatReceiptNumber(new Date("2026-09-21T10:00:00Z"), 7)).toBe("POS-20260921-0007");
  });

  it("escapeXml scapă caracterele speciale din numele/CUI-ul clientului înainte de UBL XML", () => {
    expect(escapeXml(`SC "Alfa" & <Beta> S.R.L.`)).toBe(
      "SC &quot;Alfa&quot; &amp; &lt;Beta&gt; S.R.L.",
    );
    expect(escapeXml("O'Brien")).toBe("O&apos;Brien");
    expect(escapeXml("Client normal SRL")).toBe("Client normal SRL");
  });
});
