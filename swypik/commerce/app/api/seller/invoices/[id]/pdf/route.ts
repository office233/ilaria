/**
 * GET /api/seller/invoices/[id]/pdf — factura ca PDF generat pe server
 * (inline: se deschide în vizualizator, de unde se tipărește / partajează).
 * Auth: sesiunea sellerului sau un link semnat (/api/seller/files/link).
 */
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { withErrorHandling } from "@/lib/api-handler";
import { formatMoneyCents } from "@/lib/i18n/currency";
import { renderInvoicePdf } from "@/lib/seller/documents/invoice-pdf";
import { fileHeaders, resolveSellerForFile, sellerFileLocale } from "@/lib/seller/file-links";
import { loadSellerInvoiceDocument } from "@/lib/seller/invoice-document";
import { isUuid } from "@/lib/validation/uuid";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  const sellerId = await resolveSellerForFile(req, "invoice_pdf", id);
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const invoice = await loadSellerInvoiceDocument(sellerId, id);
  if (!invoice) return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });

  const locale = await sellerFileLocale(req);
  const t = await getTranslations({ locale, namespace: "sellerBilling.documents" });
  const pdf = renderInvoicePdf(invoice, (key, values) => t(key, values), (cents) =>
    formatMoneyCents(cents, invoice.currency, locale),
  );
  return new Response(new Uint8Array(pdf), {
    headers: fileHeaders("application/pdf", `${invoice.number}.pdf`, "inline"),
  });
});
