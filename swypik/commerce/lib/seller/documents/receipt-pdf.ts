/**
 * Bonul POS ca PDF îngust (80 mm, format de imprimantă termică). E un bon
 * NEFISCAL — bonul fiscal îl emite casa de marcat; documentul o spune explicit.
 */
import { SimplePdf, wrapText } from "@/lib/pdf/simple-pdf";
import type { EfacturaSupplier } from "@/lib/seller/efactura/ubl";
import { formatAddress, type DocT } from "./invoice-pdf";

export type ReceiptData = {
  receiptNumber: string;
  createdAt: string;
  paymentMethod: "cash" | "card";
  totalCents: number;
  vatRatePct: number;
  items: Array<{ title: string; quantity: number; price: number }>;
  seller: EfacturaSupplier;
};

const WIDTH = 226.77; // 80 mm
const PAD = 12;

export function renderReceiptPdf(
  data: ReceiptData,
  t: DocT,
  money: (cents: number) => string,
  formatDate: (iso: string) => string,
): Buffer {
  const inner = WIDTH - PAD * 2;
  const itemLines = data.items.reduce((n, i) => n + wrapText(i.title || "-", inner, 8).length + 1, 0);
  const pdf = new SimplePdf(WIDTH, 230 + itemLines * 11);
  const center = WIDTH / 2;
  let y = PAD;

  pdf.text(center, y, data.seller.legalName || "-", { size: 10, font: "bold", align: "center" });
  y += 13;
  if (data.seller.cui) {
    pdf.text(center, y, t("cui", { cui: data.seller.cui }), { size: 7, align: "center" });
    y += 10;
  }
  const address = formatAddress(data.seller.address);
  for (const line of address ? wrapText(address, inner, 7) : []) {
    pdf.text(center, y, line, { size: 7, align: "center", gray: 0.3 });
    y += 9;
  }
  y += 4;
  pdf.text(center, y, t("nonFiscalReceipt"), { size: 8, font: "bold", align: "center" });
  y += 11;
  pdf.text(PAD, y, data.receiptNumber, { size: 7 });
  pdf.text(WIDTH - PAD, y, formatDate(data.createdAt), { size: 7, align: "right" });
  y += 10;
  pdf.line(PAD, y, WIDTH - PAD, y, 0.5);
  y += 6;

  for (const item of data.items) {
    const qty = Math.max(1, Math.trunc(item.quantity));
    const unit = Math.round(item.price * 100);
    for (const line of wrapText(item.title || "-", inner, 8)) {
      pdf.text(PAD, y, line, { size: 8 });
      y += 10;
    }
    pdf.text(PAD + 8, y, `${qty} x ${money(unit)}`, { size: 7, gray: 0.3 });
    pdf.text(WIDTH - PAD, y, money(unit * qty), { size: 8, align: "right" });
    y += 11;
  }

  pdf.line(PAD, y, WIDTH - PAD, y, 0.5);
  y += 6;
  const vatCents = data.totalCents - Math.round(data.totalCents / (1 + data.vatRatePct / 100));
  pdf.text(PAD, y, t("vatIncluded", { rate: data.vatRatePct }), { size: 7 });
  pdf.text(WIDTH - PAD, y, money(vatCents), { size: 7, align: "right" });
  y += 11;
  pdf.text(PAD, y, t("total"), { size: 11, font: "bold" });
  pdf.text(WIDTH - PAD, y, money(data.totalCents), { size: 11, font: "bold", align: "right" });
  y += 16;
  pdf.text(PAD, y, t(data.paymentMethod === "cash" ? "paidCash" : "paidCard"), { size: 8 });
  y += 16;
  pdf.text(center, y, t("thankYou"), { size: 8, align: "center", gray: 0.3 });
  return pdf.toBuffer();
}
