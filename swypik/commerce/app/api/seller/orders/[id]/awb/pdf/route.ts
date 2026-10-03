/**
 * GET /api/seller/orders/[id]/awb/pdf — eticheta de expediere (100×150 mm) ca PDF,
 * cu cod de bare Code 128 (AWB-ul curierului sau cod intern marcat ca atare).
 * Auth: sesiunea sellerului sau un link semnat (/api/seller/files/link).
 */
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { withErrorHandling } from "@/lib/api-handler";
import { formatMoneyCents } from "@/lib/i18n/currency";
import { loadAwbLabel } from "@/lib/seller/awb-label";
import { renderAwbPdf } from "@/lib/seller/documents/awb-pdf";
import { fileHeaders, resolveSellerForFile, sellerFileLocale } from "@/lib/seller/file-links";
import { isUuid } from "@/lib/validation/uuid";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  const sellerId = await resolveSellerForFile(req, "awb_label", id);
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const label = await loadAwbLabel(sellerId, id);
  if (!label) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });

  const locale = await sellerFileLocale(req);
  const t = await getTranslations({ locale, namespace: "sellerOrders.awbPdf" });
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Bucharest" });
  const pdf = renderAwbPdf(
    label,
    (key, values) => t(key, values),
    (cents) => formatMoneyCents(cents, label.order.currency, locale),
    (iso) => dateFmt.format(new Date(iso)),
  );
  return new Response(new Uint8Array(pdf), {
    headers: fileHeaders("application/pdf", `AWB-${label.order.orderNumber}.pdf`, "inline"),
  });
});
