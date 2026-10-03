/**
 * GET /api/seller/pos/sales/[id]/receipt — bonul POS (nefiscal) ca PDF.
 * Auth: sesiunea sellerului sau un link semnat (/api/seller/files/link).
 */
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { withErrorHandling } from "@/lib/api-handler";
import { formatMoneyCents } from "@/lib/i18n/currency";
import { renderReceiptPdf } from "@/lib/seller/documents/receipt-pdf";
import { fileHeaders, resolveSellerForFile, sellerFileLocale } from "@/lib/seller/file-links";
import { loadSellerFiscalProfile } from "@/lib/seller/fiscal-profile";
import { RO_VAT_STANDARD_PCT } from "@/lib/seller/invoicing";
import { isUuid } from "@/lib/validation/uuid";

export const dynamic = "force-dynamic";

type SaleRow = {
  receipt_number: string;
  created_at: string;
  payment_method: "cash" | "card";
  total_cents: string | number;
  currency: string | null;
  items: Array<{ title?: unknown; quantity?: unknown; price?: unknown }> | null;
};

export const GET = withErrorHandling(async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  const sellerId = await resolveSellerForFile(req, "pos_receipt", id);
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const { rows } = await dbQuery<SaleRow>(
    `SELECT receipt_number, created_at, payment_method, total_cents, currency, items
       FROM seller_pos_sales WHERE id = $1 AND seller_id = $2 LIMIT 1`,
    [id, sellerId],
  );
  const sale = rows[0];
  if (!sale) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });

  const locale = await sellerFileLocale(req);
  const t = await getTranslations({ locale, namespace: "sellerPos.receiptPdf" });
  const currency = (sale.currency || "RON").toUpperCase();
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Bucharest" });

  const pdf = renderReceiptPdf(
    {
      receiptNumber: sale.receipt_number,
      createdAt: sale.created_at,
      paymentMethod: sale.payment_method,
      totalCents: Number(sale.total_cents) || 0,
      vatRatePct: RO_VAT_STANDARD_PCT,
      items: (sale.items ?? []).map((i) => ({
        title: typeof i.title === "string" ? i.title : "",
        quantity: Number(i.quantity) || 1,
        price: Number(i.price) || 0,
      })),
      seller: await loadSellerFiscalProfile(sellerId),
    },
    (key, values) => t(key, values),
    (cents) => formatMoneyCents(cents, currency, locale),
    (iso) => dateFmt.format(new Date(iso)),
  );
  return new Response(new Uint8Array(pdf), {
    headers: fileHeaders("application/pdf", `${sale.receipt_number}.pdf`, "inline"),
  });
});
