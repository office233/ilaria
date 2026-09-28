/**
 * Eticheta de expediere 100×150 mm ca PDF, cu cod de bare Code 128 scanabil.
 *  - există AWB de la curier → codul de bare e numărul AWB;
 *  - nu există → cod INTERN al comenzii, marcat vizibil că nu e AWB de curier
 *    (nu se inventează un număr de curier).
 */
import { code128Bars } from "@/lib/barcode/code128";
import { drawBars, SimplePdf, wrapText } from "@/lib/pdf/simple-pdf";
import { internalOrderCode, type AwbLabel } from "@/lib/seller/awb-label";
import type { DocT } from "./invoice-pdf";

const W = 283.46;
const H = 425.2;
const PAD = 12;

/** Ce cod de bare se tipărește și dacă e AWB real de curier. */
export function awbBarcodeValue(label: AwbLabel): { value: string; isCarrierAwb: boolean } {
  const awb = label.awb.trackingNumber?.trim();
  if (awb && /^[\x20-\x7e]{1,40}$/.test(awb)) return { value: awb, isCarrierAwb: true };
  return { value: internalOrderCode(label.order.id), isCarrierAwb: false };
}

export function renderAwbPdf(label: AwbLabel, t: DocT, money: (cents: number) => string, formatDate: (iso: string) => string): Buffer {
  const pdf = new SimplePdf(W, H);
  const inner = W - PAD * 2;
  let y = PAD;

  pdf.text(PAD, y, label.awb.carrierName || t("noCarrier"), { size: 12, font: "bold" });
  pdf.text(W - PAD, y + 2, formatDate(label.awb.generatedAt), { size: 7, align: "right", gray: 0.3 });
  y += 20;

  const { value, isCarrierAwb } = awbBarcodeValue(label);
  const { bars, totalModules } = code128Bars(value);
  drawBars(pdf, bars, totalModules, PAD, y, inner, 60);
  y += 64;
  pdf.text(W / 2, y, value, { size: 11, font: "bold", align: "center" });
  y += 14;
  if (!isCarrierAwb) {
    pdf.rect(PAD, y - 2, inner, 14, { gray: 0.1 });
    pdf.text(W / 2, y, t("internalBarcode"), { size: 7, font: "bold", align: "center", gray: 1 });
    y += 16;
  } else {
    pdf.text(W / 2, y, t("orderRef", { order: label.order.orderNumber }), { size: 7, align: "center", gray: 0.3 });
    y += 12;
  }
  pdf.line(PAD, y, W - PAD, y, 1);
  y += 6;

  const block = (title: string, lines: string[], big = false) => {
    pdf.text(PAD, y, title, { size: 7, font: "bold", gray: 0.4 });
    y += 10;
    lines.filter(Boolean).forEach((line, i) => {
      for (const part of wrapText(line, inner, big && i === 0 ? 11 : 8)) {
        pdf.text(PAD, y, part, { size: big && i === 0 ? 11 : 8, font: i === 0 ? "bold" : "regular" });
        y += big && i === 0 ? 13 : 10;
      }
    });
    y += 4;
  };

  const r = label.recipient;
  block(
    t("recipient"),
    [
      r.name,
      r.phone ? t("phone", { phone: r.phone }) : "",
      r.line1,
      r.line2,
      [r.postalCode, r.city, r.county].filter(Boolean).join(", "),
      r.country,
      r.lockerName ? t("locker", { locker: r.lockerName }) : "",
    ],
    true,
  );
  pdf.line(PAD, y, W - PAD, y, 0.5);
  y += 6;
  const s = label.sender;
  block(t("sender"), [
    s.name,
    s.cui ? t("cui", { cui: s.cui }) : "",
    [s.address, s.city, s.county].filter(Boolean).join(", "),
    s.phone ? t("phone", { phone: s.phone }) : "",
  ]);
  pdf.line(PAD, y, W - PAD, y, 0.5);
  y += 6;

  const specs = [
    t("parcels", { count: label.awb.parcelsCount }),
    label.awb.weightKg != null ? t("weight", { kg: label.awb.weightKg }) : "",
    t("declaredValue", { value: money(label.order.totalCents) }),
  ].filter(Boolean);
  pdf.text(PAD, y, specs.join("  ·  "), { size: 8 });
  y += 12;
  if (label.awb.notes) {
    for (const part of wrapText(t("notes", { notes: label.awb.notes }), inner, 7).slice(0, 3)) {
      pdf.text(PAD, y, part, { size: 7, gray: 0.3 });
      y += 9;
    }
  }
  return pdf.toBuffer();
}
