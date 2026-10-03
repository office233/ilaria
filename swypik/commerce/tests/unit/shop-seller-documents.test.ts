import { describe, it, expect } from "vitest";
import { code128Bars, code128Symbols, CODE128_PATTERNS } from "@/lib/barcode/code128";
import { SimplePdf, toWinAnsi, textWidth } from "@/lib/pdf/simple-pdf";
import { isValidCuiDigits, parseCui, validCui } from "@/lib/seller/efactura/cui";
import { normalizeBucharestSector, normalizeRoCounty } from "@/lib/seller/efactura/counties";
import {
  buildEfacturaXml,
  efacturaLines,
  EfacturaValidationError,
  validateEfacturaDocument,
  type EfacturaInvoice,
} from "@/lib/seller/efactura/ubl";
import { sellerFiscalProfileFromRow } from "@/lib/seller/fiscal-profile";
import { buildPosCatalog } from "@/lib/seller/pos-catalog";
import { awbBarcodeValue } from "@/lib/seller/documents/awb-pdf";
import { renderInvoicePdf } from "@/lib/seller/documents/invoice-pdf";
import { signSellerFileToken, verifySellerFileToken } from "@/lib/seller/file-links";
import { publishableKeyLooksValid, shopPaymentsConfigured } from "@/lib/shop/payments-config";
import { sellerCancelRefundAmount } from "@/lib/seller/order-actions";
import type { AwbLabel } from "@/lib/seller/awb-label";

// CUI-uri cu cifră de control corectă (calculată cu cheia 753217532).
const SUPPLIER_CUI = "RO18547290";
const CUSTOMER_CUI = "14399840";

function invoice(overrides: Partial<EfacturaInvoice> = {}): EfacturaInvoice {
  return {
    number: "FACT-0001",
    issueDate: "2026-09-28",
    currency: "RON",
    vatRatePct: 21,
    status: "issued",
    subtotalCents: 24793,
    vatCents: 5207,
    totalCents: 30000,
    items: [
      { title: "Tricou & bluză <S>", quantity: 2, price: 100 },
      { title: "Șapcă", quantity: 1, price: 100 },
    ],
    supplier: {
      legalName: "Magazinul Real SRL",
      cui: SUPPLIER_CUI,
      tradeRegister: "J12/345/2024",
      address: { street: "Str. Memorandumului 1", city: "Cluj-Napoca", county: "Cluj", postalCode: "400114", country: "RO" },
      iban: "RO49AAAA1B31007593840000",
      email: "shop@example.ro",
    },
    customer: {
      name: "Client SRL",
      cui: CUSTOMER_CUI,
      address: { street: "Bd. Unirii 10", city: "Sector 3", county: "București", country: "RO" },
    },
    ...overrides,
  };
}

describe("CUI românesc", () => {
  it("validează cifra de control și prefixul RO", () => {
    expect(isValidCuiDigits("18547290")).toBe(true);
    expect(isValidCuiDigits("18547291")).toBe(false);
    expect(parseCui("RO 18547290")).toEqual({ digits: "18547290", vatRegistered: true });
    expect(validCui("99999999")).toBeNull();
    expect(validCui(CUSTOMER_CUI)?.vatRegistered).toBe(false);
  });
});

describe("județe CIUS-RO", () => {
  it("normalizează nume și coduri la ISO 3166-2:RO", () => {
    expect(normalizeRoCounty("Cluj")).toBe("RO-CJ");
    expect(normalizeRoCounty("CJ")).toBe("RO-CJ");
    expect(normalizeRoCounty("judetul Brasov")).toBe("RO-BV");
    expect(normalizeRoCounty("București")).toBe("RO-B");
    expect(normalizeRoCounty("Atlantis")).toBeNull();
    expect(normalizeBucharestSector("sector 3")).toBe("SECTOR3");
    expect(normalizeBucharestSector("Cluj")).toBeNull();
  });
});

describe("e-Factura UBL CIUS-RO", () => {
  it("construiește XML-ul din furnizorul și liniile reale (fără date inventate)", () => {
    const xml = buildEfacturaXml(invoice());
    expect(xml).toContain("urn:efactura.mfinante.ro:CIUS-RO:1.0.1");
    expect(xml).toContain("<cbc:RegistrationName>Magazinul Real SRL</cbc:RegistrationName>");
    expect(xml).toContain("<cbc:CompanyID>RO18547290</cbc:CompanyID>");
    expect(xml).toContain("<cbc:CountrySubentity>RO-CJ</cbc:CountrySubentity>");
    expect(xml).toContain("<cbc:CityName>SECTOR3</cbc:CityName>");
    expect(xml).toContain("<cbc:CountrySubentity>RO-B</cbc:CountrySubentity>");
    expect(xml).toContain("Tricou &amp; bluză &lt;S&gt;");
    expect(xml.match(/<cac:InvoiceLine>/g)).toHaveLength(2);
    expect(xml).not.toContain("Swypik Merchant");
    expect(xml).not.toContain("RO99999999");
    expect(xml).toContain('<cbc:PayableAmount currencyID="RON">300.00</cbc:PayableAmount>');
  });

  it("suma liniilor == LineExtensionAmount și TVA == total − net (BR-CO-10/15)", () => {
    const inv = invoice();
    const lines = efacturaLines(inv);
    const net = lines.reduce((s, l) => s + l.netCents, 0);
    expect(net).toBe(inv.subtotalCents);
    const xml = buildEfacturaXml(inv);
    expect(xml).toContain(`<cbc:LineExtensionAmount currencyID="RON">${(net / 100).toFixed(2)}</cbc:LineExtensionAmount>\n    <cbc:TaxExclusiveAmount`);
    expect(xml).toContain(`<cbc:TaxAmount currencyID="RON">${((inv.totalCents - net) / 100).toFixed(2)}</cbc:TaxAmount>`);
  });

  it("raportează ce lipsește în loc să genereze XML", () => {
    const inv = invoice({
      supplier: { legalName: "", cui: "RO123", address: { street: "", city: "", county: "", country: "RO" } },
      customer: { name: "X", address: null },
    });
    const errors = validateEfacturaDocument(inv);
    expect(errors).toEqual(
      expect.arrayContaining([
        "supplier_name_missing",
        "supplier_cui_invalid",
        "supplier_street_missing",
        "supplier_county_invalid",
        "customer_address_missing",
      ]),
    );
    expect(() => buildEfacturaXml(inv)).toThrow(EfacturaValidationError);
  });

  it("firmă neplătitoare de TVA cu TVA pe factură → eroare; fără TVA → categoria O", () => {
    const supplier = { ...invoice().supplier, cui: "18547290" };
    expect(validateEfacturaDocument(invoice({ supplier }))).toContain("supplier_not_vat_registered");
    const xml = buildEfacturaXml(invoice({ supplier, vatRatePct: 0, subtotalCents: 30000, vatCents: 0 }));
    expect(xml).toContain("<cbc:ID>O</cbc:ID>");
    expect(xml).toContain("VATEX-EU-O");
    expect(xml).not.toContain("<cac:PartyTaxScheme><cbc:CompanyID>RO18547290");
  });
});

describe("profil fiscal seller", () => {
  it("citește adresa din business_details, fără valori inventate", () => {
    const p = sellerFiscalProfileFromRow({ name: "Shop", cui: null, email: "a@b.ro", phone: null, business_details: { city: "Iași" } });
    expect(p.cui).toBe("");
    expect(p.address.street).toBe("");
    expect(p.address.city).toBe("Iași");
    expect(p.legalName).toBe("Shop");
  });
});

describe("PDF minimal", () => {
  it("produce un PDF cu xref valid și diacritice transliterate", () => {
    const pdf = new SimplePdf(200, 200);
    pdf.text(10, 10, "Șapcă (test) ăâîșț");
    const buf = pdf.toBuffer().toString("latin1");
    expect(buf.startsWith("%PDF-1.4")).toBe(true);
    expect(buf.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(buf)?.[1]);
    expect(buf.slice(xref, xref + 4)).toBe("xref");
    expect(buf).toContain("(Sapca \\(test\\) a\\342\\356st)");
    expect(toWinAnsi("€")).toEqual([0x80]);
    expect(textWidth("ii", 10)).toBeLessThan(textWidth("WW", 10));
  });

  it("randează factura PDF cu furnizorul real", () => {
    const pdf = renderInvoicePdf(invoice(), (k, v) => `${k}${v ? JSON.stringify(v) : ""}`, (c) => `${c}`);
    const s = pdf.toString("latin1");
    expect(s).toContain("Magazinul Real SRL");
    expect(s).toContain("FACT-0001");
  });
});

describe("Code 128", () => {
  it("tabel complet și checksum corect", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    // „PJJ123C” în setul B: checksum (104 + Σ v·i) mod 103 = 55.
    expect(code128Symbols("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    // Doar cifre, lungime pară → setul C.
    expect(code128Symbols("123456")[0]).toBe(105);
    const { bars, totalModules } = code128Bars("AWB1");
    expect(bars.length).toBeGreaterThan(0);
    expect(totalModules).toBe(20 + 11 * 6 + 13);
  });

  it("eticheta AWB: numărul curierului sau cod intern marcat ca atare", () => {
    const base = { order: { id: "abcdef12-0000-4000-8000-000000000000" }, awb: { trackingNumber: null } } as unknown as AwbLabel;
    expect(awbBarcodeValue(base)).toEqual({ value: "SWY-ABCDEF12", isCarrierAwb: false });
    const real = { ...base, awb: { trackingNumber: "1ONB24123456" } } as unknown as AwbLabel;
    expect(awbBarcodeValue(real)).toEqual({ value: "1ONB24123456", isCarrierAwb: true });
  });
});

describe("POS catalog", () => {
  it("stoc negestionat = null (fără „10” inventat), variante pe rânduri separate", () => {
    const items = buildPosCatalog(
      [
        { id: "p1", title: "Cană", price_cents: 2500, category: null, image_url: null, metadata: {} },
        { id: "p2", title: "Tricou", price_cents: 5000, category: null, image_url: null, metadata: { available_stock: 3 } },
      ],
      [{ id: "v1", product_id: "p2", title: "M", sku: "T-M", price_cents: null, inventory_quantity: 2 }],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ key: "p1", stock: null, variantId: null });
    expect(items[1]).toMatchObject({ key: "p2:v1", variantId: "v1", stock: 2, priceCents: 5000, sku: "T-M" });
  });
});

describe("link-uri semnate pentru fișiere", () => {
  it("token valid doar pentru același tip/id și înainte de expirare", () => {
    const now = Date.now();
    const tok = signSellerFileToken("seller-1", "invoice_pdf", "id-1", now);
    expect(verifySellerFileToken(tok, "invoice_pdf", "id-1", now)).toBe("seller-1");
    expect(verifySellerFileToken(tok, "invoice_xml", "id-1", now)).toBeNull();
    expect(verifySellerFileToken(tok, "invoice_pdf", "id-2", now)).toBeNull();
    expect(verifySellerFileToken(tok, "invoice_pdf", "id-1", now + 3_600_001)).toBeNull();
    expect(verifySellerFileToken(`${tok}x`, "invoice_pdf", "id-1", now)).toBeNull();
  });
});

describe("configurare plăți", () => {
  it("cheile placeholder = plăți indisponibile", () => {
    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(shopPaymentsConfigured({ ...prod, STRIPE_SECRET_KEY: "sk_live_PLACEHOLDER", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abc" })).toBe(false);
    expect(shopPaymentsConfigured(prod)).toBe(false);
    expect(shopPaymentsConfigured({ ...prod, STRIPE_SECRET_KEY: "sk_live_abc123", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abc123" })).toBe(true);
    expect(publishableKeyLooksValid("")).toBe(false);
    expect(publishableKeyLooksValid("pk_test_123")).toBe(true);
  });
});

describe("anulare seller — suma de rambursat", () => {
  it("refund total doar fără alți selleri și fără expedieri parțiale", () => {
    expect(sellerCancelRefundAmount({ otherSellersOpenItems: 0, sellerShippedItems: 0, sellerOpenCents: 5000 })).toBeNull();
    expect(sellerCancelRefundAmount({ otherSellersOpenItems: 0, sellerShippedItems: 1, sellerOpenCents: 2000 })).toBe(2000);
    expect(sellerCancelRefundAmount({ otherSellersOpenItems: 2, sellerShippedItems: 0, sellerOpenCents: 3500 })).toBe(3500);
  });
});
