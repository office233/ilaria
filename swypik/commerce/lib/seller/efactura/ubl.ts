/**
 * e-Factura: factură UBL 2.1 conform CIUS-RO 1.0.1 (EN 16931), construită din
 * datele reale ale sellerului (profil fiscal) și din liniile facturii.
 *
 * Pur: fără DB. `validateEfacturaDocument` întoarce coduri de eroare stabile
 * (traduse în UI); XML-ul se generează DOAR dacă nu există erori — niciodată
 * cu date inventate (vechiul export punea „Swypik Merchant”/RO99999999).
 */
import { normalizeBucharestSector, normalizeRoCounty } from "./counties";
import { validCui } from "./cui";

export const CIUS_RO_CUSTOMIZATION_ID = "urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1";
/** Cod generic pentru persoane fizice fără CNP comunicat (reglementarea B2C ANAF). */
export const EFACTURA_ANONYMOUS_BUYER_ID = "0000000000000";

export type EfacturaAddress = {
  street: string;
  city: string;
  county: string;
  postalCode?: string | null;
  country: string;
};

export type EfacturaSupplier = {
  legalName: string;
  cui: string;
  tradeRegister?: string | null;
  address: EfacturaAddress;
  iban?: string | null;
  vatExemptionReason?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type EfacturaCustomer = {
  name: string;
  cui?: string | null;
  address: EfacturaAddress | null;
  /** Adresa ca text liber (facturi vechi) — doar pentru PDF, nu pentru XML. */
  addressText?: string | null;
};

export type EfacturaLineInput = { title: string; quantity: number; price: number };

export type EfacturaInvoice = {
  number: string;
  issueDate: string;
  currency: string;
  vatRatePct: number;
  status: string;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  items: EfacturaLineInput[];
  supplier: EfacturaSupplier;
  customer: EfacturaCustomer;
};

export const EFACTURA_ERROR_CODES = [
  "invoice_not_issued",
  "lines_missing",
  "supplier_name_missing",
  "supplier_cui_invalid",
  "supplier_street_missing",
  "supplier_city_missing",
  "supplier_county_invalid",
  "supplier_country_invalid",
  "supplier_bucharest_sector",
  "supplier_not_vat_registered",
  "vat_exemption_reason_missing",
  "customer_name_missing",
  "customer_cui_invalid",
  "customer_address_missing",
  "customer_street_missing",
  "customer_city_missing",
  "customer_county_invalid",
  "customer_country_invalid",
  "customer_bucharest_sector",
] as const;
export type EfacturaErrorCode = (typeof EFACTURA_ERROR_CODES)[number];

export type EfacturaLine = {
  id: number;
  name: string;
  quantity: number;
  netCents: number;
  unitNetPrice: string;
};

type TaxCategory = { id: "S" | "E" | "O"; percent: number | null; exemptionCode?: string; exemptionReason?: string };

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const amount = (cents: number) => (cents / 100).toFixed(2);

function isCountry(code: string): boolean {
  return /^[A-Z]{2}$/.test(code);
}

function lineGrossCents(item: EfacturaLineInput): number {
  const qty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
  return Math.round((Number(item.price) || 0) * 100) * qty;
}

/**
 * Liniile cu valoare netă: subtotalul facturii (baza impozabilă stocată) se
 * împarte proporțional cu valoarea brută a fiecărei linii (metoda celui mai
 * mare rest), astfel încât suma liniilor == LineExtensionAmount exact (BR-CO-10).
 */
export function efacturaLines(invoice: Pick<EfacturaInvoice, "items" | "subtotalCents">): EfacturaLine[] {
  const gross = invoice.items.map(lineGrossCents);
  const totalGross = gross.reduce((a, b) => a + b, 0);
  const shares = gross.map((g) => (totalGross > 0 ? (g * invoice.subtotalCents) / totalGross : 0));
  const nets = shares.map(Math.floor);
  let rest = invoice.subtotalCents - nets.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => ({ i, frac: s - Math.floor(s) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length, rest--) nets[order[k].i] += 1;
  return invoice.items.map((item, idx) => {
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1));
    const unit = nets[idx] / 100 / quantity;
    return {
      id: idx + 1,
      name: item.title.trim(),
      quantity,
      netCents: nets[idx],
      unitNetPrice: Number.isInteger(nets[idx] / quantity) ? unit.toFixed(2) : unit.toFixed(4),
    };
  });
}

function taxCategory(invoice: EfacturaInvoice): TaxCategory {
  const vatRegistered = validCui(invoice.supplier.cui)?.vatRegistered ?? false;
  if (!vatRegistered) return { id: "O", percent: null, exemptionCode: "VATEX-EU-O" };
  if (invoice.vatRatePct > 0) return { id: "S", percent: invoice.vatRatePct };
  return { id: "E", percent: 0, exemptionReason: invoice.supplier.vatExemptionReason?.trim() || undefined };
}

/** Adresa normalizată pentru CIUS-RO (județ ISO, sector în București). */
function normalizeAddress(address: EfacturaAddress): EfacturaAddress {
  const country = (address.country || "").trim().toUpperCase();
  if (country !== "RO") return { ...address, country, street: address.street.trim(), city: address.city.trim() };
  const county = normalizeRoCounty(address.county) ?? "";
  const city = county === "RO-B" ? normalizeBucharestSector(address.city) ?? "" : address.city.trim();
  return { street: address.street.trim(), city, county, postalCode: address.postalCode?.trim() || null, country };
}

function validateAddress(address: EfacturaAddress, prefix: "supplier" | "customer", errors: EfacturaErrorCode[]): void {
  const country = (address.country || "").trim().toUpperCase();
  if (!address.street?.trim()) errors.push(`${prefix}_street_missing`);
  if (!isCountry(country)) {
    errors.push(`${prefix}_country_invalid`);
    return;
  }
  if (country === "RO") {
    const county = normalizeRoCounty(address.county);
    if (!county) errors.push(`${prefix}_county_invalid`);
    if (county === "RO-B") {
      if (!normalizeBucharestSector(address.city)) errors.push(`${prefix}_bucharest_sector`);
      return;
    }
  }
  if (!address.city?.trim()) errors.push(`${prefix}_city_missing`);
}

export function validateEfacturaDocument(invoice: EfacturaInvoice): EfacturaErrorCode[] {
  const errors: EfacturaErrorCode[] = [];
  if (invoice.status !== "issued" && invoice.status !== "paid") errors.push("invoice_not_issued");
  if (invoice.items.length === 0 || invoice.items.some((i) => !i.title?.trim())) errors.push("lines_missing");

  const s = invoice.supplier;
  if (!s.legalName?.trim()) errors.push("supplier_name_missing");
  const supplierCui = validCui(s.cui);
  if (!supplierCui) errors.push("supplier_cui_invalid");
  validateAddress(s.address, "supplier", errors);
  if (supplierCui && !supplierCui.vatRegistered && invoice.vatRatePct > 0) errors.push("supplier_not_vat_registered");
  if (supplierCui?.vatRegistered && invoice.vatRatePct === 0 && !s.vatExemptionReason?.trim()) {
    errors.push("vat_exemption_reason_missing");
  }

  const c = invoice.customer;
  if (!c.name?.trim()) errors.push("customer_name_missing");
  if (c.cui?.trim() && !validCui(c.cui)) errors.push("customer_cui_invalid");
  if (!c.address) errors.push("customer_address_missing");
  else validateAddress(c.address, "customer", errors);

  return errors;
}

function addressXml(address: EfacturaAddress): string {
  const a = normalizeAddress(address);
  return [
    "<cac:PostalAddress>",
    `<cbc:StreetName>${escapeXml(a.street)}</cbc:StreetName>`,
    `<cbc:CityName>${escapeXml(a.city)}</cbc:CityName>`,
    a.postalCode ? `<cbc:PostalZone>${escapeXml(a.postalCode)}</cbc:PostalZone>` : "",
    a.county ? `<cbc:CountrySubentity>${escapeXml(a.county)}</cbc:CountrySubentity>` : "",
    `<cac:Country><cbc:IdentificationCode>${escapeXml(a.country)}</cbc:IdentificationCode></cac:Country>`,
    "</cac:PostalAddress>",
  ].join("");
}

function vatSchemeXml(companyId: string): string {
  return `<cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(companyId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`;
}

function taxCategoryXml(tag: "TaxCategory" | "ClassifiedTaxCategory", cat: TaxCategory, withReason: boolean): string {
  return [
    `<cac:${tag}>`,
    `<cbc:ID>${cat.id}</cbc:ID>`,
    cat.percent != null ? `<cbc:Percent>${cat.percent.toFixed(2)}</cbc:Percent>` : "",
    withReason && cat.exemptionCode ? `<cbc:TaxExemptionReasonCode>${cat.exemptionCode}</cbc:TaxExemptionReasonCode>` : "",
    withReason && cat.exemptionReason ? `<cbc:TaxExemptionReason>${escapeXml(cat.exemptionReason)}</cbc:TaxExemptionReason>` : "",
    "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>",
    `</cac:${tag}>`,
  ].join("");
}

export class EfacturaValidationError extends Error {
  constructor(readonly codes: EfacturaErrorCode[]) {
    super("efactura_invalid");
  }
}

/** XML-ul UBL CIUS-RO. Aruncă `EfacturaValidationError` dacă documentul e incomplet. */
export function buildEfacturaXml(invoice: EfacturaInvoice): string {
  const errors = validateEfacturaDocument(invoice);
  if (errors.length > 0) throw new EfacturaValidationError(errors);

  const cur = escapeXml(invoice.currency.toUpperCase());
  const cat = taxCategory(invoice);
  const lines = efacturaLines(invoice);
  const netTotal = lines.reduce((sum, l) => sum + l.netCents, 0);
  const vatCents = cat.id === "O" || cat.id === "E" ? 0 : invoice.totalCents - netTotal;
  const grossTotal = netTotal + vatCents;

  const s = invoice.supplier;
  const sCui = validCui(s.cui)!;
  const c = invoice.customer;
  const cCui = validCui(c.cui);

  const supplierXml = [
    "<cac:AccountingSupplierParty><cac:Party>",
    addressXml(s.address),
    sCui.vatRegistered ? vatSchemeXml(`RO${sCui.digits}`) : "",
    "<cac:PartyLegalEntity>",
    `<cbc:RegistrationName>${escapeXml(s.legalName.trim())}</cbc:RegistrationName>`,
    `<cbc:CompanyID>${escapeXml(sCui.vatRegistered ? s.tradeRegister?.trim() || sCui.digits : sCui.digits)}</cbc:CompanyID>`,
    "</cac:PartyLegalEntity>",
    s.email || s.phone
      ? `<cac:Contact>${s.phone ? `<cbc:Telephone>${escapeXml(s.phone)}</cbc:Telephone>` : ""}${
          s.email ? `<cbc:ElectronicMail>${escapeXml(s.email)}</cbc:ElectronicMail>` : ""
        }</cac:Contact>`
      : "",
    "</cac:Party></cac:AccountingSupplierParty>",
  ].join("");

  const customerXml = [
    "<cac:AccountingCustomerParty><cac:Party>",
    addressXml(c.address!),
    cCui?.vatRegistered ? vatSchemeXml(`RO${cCui.digits}`) : "",
    "<cac:PartyLegalEntity>",
    `<cbc:RegistrationName>${escapeXml(c.name.trim())}</cbc:RegistrationName>`,
    `<cbc:CompanyID>${escapeXml(cCui?.digits ?? EFACTURA_ANONYMOUS_BUYER_ID)}</cbc:CompanyID>`,
    "</cac:PartyLegalEntity>",
    "</cac:Party></cac:AccountingCustomerParty>",
  ].join("");

  const iban = s.iban?.replace(/\s+/g, "").toUpperCase();
  const paymentXml = iban
    ? `<cac:PaymentMeans><cbc:PaymentMeansCode>42</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>${escapeXml(iban)}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>`
    : "";

  const linesXml = lines
    .map((l) =>
      [
        "<cac:InvoiceLine>",
        `<cbc:ID>${l.id}</cbc:ID>`,
        `<cbc:InvoicedQuantity unitCode="H87">${l.quantity}</cbc:InvoicedQuantity>`,
        `<cbc:LineExtensionAmount currencyID="${cur}">${amount(l.netCents)}</cbc:LineExtensionAmount>`,
        `<cac:Item><cbc:Name>${escapeXml(l.name)}</cbc:Name>${taxCategoryXml("ClassifiedTaxCategory", cat, false)}</cac:Item>`,
        `<cac:Price><cbc:PriceAmount currencyID="${cur}">${l.unitNetPrice}</cbc:PriceAmount></cac:Price>`,
        "</cac:InvoiceLine>",
      ].join(""),
    )
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${CIUS_RO_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ID>${escapeXml(invoice.number)}</cbc:ID>
  <cbc:IssueDate>${escapeXml(invoice.issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  ${supplierXml}
  ${customerXml}
  ${paymentXml}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${amount(vatCents)}</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="${cur}">${amount(netTotal)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${cur}">${amount(vatCents)}</cbc:TaxAmount>${taxCategoryXml("TaxCategory", cat, true)}</cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${amount(netTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${amount(netTotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${amount(grossTotal)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${amount(grossTotal)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${linesXml}
</Invoice>
`;
}

/** Data emiterii în fusul orar al României (YYYY-MM-DD). */
export function efacturaIssueDate(createdAt: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(createdAt));
}
