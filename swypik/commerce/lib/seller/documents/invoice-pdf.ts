/**
 * PDF-ul facturii sellerului (A4), generat pe server. Etichetele vin traduse
 * prin `t` (namespace sellerBilling.documents); sumele prin `money`.
 */
import { SimplePdf } from "@/lib/pdf/simple-pdf";
import { normalizeRoCounty, RO_COUNTIES } from "@/lib/seller/efactura/counties";
import type { EfacturaAddress, EfacturaInvoice } from "@/lib/seller/efactura/ubl";

export type DocT = (key: string, values?: Record<string, string | number>) => string;

const MARGIN = 40;

function countyName(county: string): string {
  const code = normalizeRoCounty(county);
  return RO_COUNTIES.find((c) => c.code === code)?.name ?? county;
}

export function formatAddress(address: EfacturaAddress | null | undefined): string {
  if (!address) return "";
  return [address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.county ? countyName(address.county) : "", address.country]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export function renderInvoicePdf(invoice: EfacturaInvoice, t: DocT, money: (cents: number) => string): Buffer {
  const pdf = new SimplePdf();
  const right = pdf.width - MARGIN;
  const colWidth = (pdf.width - MARGIN * 2 - 20) / 2;

  pdf.text(MARGIN, MARGIN, t("invoiceTitle"), { size: 20, font: "bold" });
  pdf.text(right, MARGIN, t("invoiceNumber", { number: invoice.number }), { size: 11, font: "bold", align: "right" });
  pdf.text(right, MARGIN + 16, t("issueDate", { date: invoice.issueDate }), { size: 9, align: "right", gray: 0.3 });

  const partyTop = MARGIN + 50;
  const party = (x: number, title: string, lines: string[]) => {
    pdf.text(x, partyTop, title, { size: 8, font: "bold", gray: 0.4 });
    let y = partyTop + 14;
    lines.filter(Boolean).forEach((line, i) => {
      y = pdf.paragraph(x, y, line, colWidth, { size: i === 0 ? 11 : 9, font: i === 0 ? "bold" : "regular" });
    });
    return y;
  };
  const s = invoice.supplier;
  const c = invoice.customer;
  const yS = party(MARGIN, t("supplier"), [
    s.legalName,
    s.cui ? t("cui", { cui: s.cui }) : "",
    s.tradeRegister ? t("tradeRegister", { value: s.tradeRegister }) : "",
    formatAddress(s.address),
    s.iban ? t("iban", { iban: s.iban }) : "",
  ]);
  const yC = party(MARGIN + colWidth + 20, t("customer"), [
    c.name,
    c.cui ? t("cui", { cui: c.cui }) : "",
    formatAddress(c.address) || (c.addressText ?? ""),
  ]);

  let y = Math.max(yS, yC) + 20;
  const cols = { idx: MARGIN, name: MARGIN + 24, qty: right - 200, unit: right - 110, total: right };
  pdf.rect(MARGIN, y - 4, right - MARGIN, 18, { gray: 0.92 });
  pdf.text(cols.idx, y, "#", { size: 8, font: "bold" });
  pdf.text(cols.name, y, t("colItem"), { size: 8, font: "bold" });
  pdf.text(cols.qty, y, t("colQty"), { size: 8, font: "bold", align: "right" });
  pdf.text(cols.unit, y, t("colUnitPrice"), { size: 8, font: "bold", align: "right" });
  pdf.text(cols.total, y, t("colTotal"), { size: 8, font: "bold", align: "right" });
  y += 20;

  invoice.items.forEach((item, i) => {
    if (y > pdf.height - 140) {
      pdf.addPage();
      y = MARGIN;
    }
    const qty = Math.max(1, Math.trunc(item.quantity));
    const unitCents = Math.round(item.price * 100);
    pdf.text(cols.idx, y, String(i + 1), { size: 9 });
    const endY = pdf.paragraph(cols.name, y, item.title, cols.qty - cols.name - 40, { size: 9 });
    pdf.text(cols.qty, y, String(qty), { size: 9, align: "right" });
    pdf.text(cols.unit, y, money(unitCents), { size: 9, align: "right" });
    pdf.text(cols.total, y, money(unitCents * qty), { size: 9, align: "right" });
    y = Math.max(endY, y + 12) + 4;
    pdf.line(MARGIN, y - 2, right, y - 2, 0.3, 0.8);
  });

  y += 10;
  const totalRow = (label: string, value: string, bold = false) => {
    pdf.text(right - 120, y, label, { size: bold ? 11 : 9, font: bold ? "bold" : "regular", align: "right" });
    pdf.text(right, y, value, { size: bold ? 11 : 9, font: bold ? "bold" : "regular", align: "right" });
    y += bold ? 18 : 14;
  };
  totalRow(t("subtotal"), money(invoice.subtotalCents));
  totalRow(t("vat", { rate: invoice.vatRatePct }), money(invoice.vatCents));
  totalRow(t("total"), money(invoice.totalCents), true);

  pdf.text(MARGIN, pdf.height - MARGIN - 10, t("footer"), { size: 7, gray: 0.5 });
  return pdf.toBuffer();
}
