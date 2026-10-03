/**
 * GET /api/seller/invoices/[id]/efactura — XML-ul e-Factura (UBL 2.1, CIUS-RO),
 * construit pe server din profilul fiscal real al sellerului și din liniile facturii.
 *
 *  ?check=1  → JSON { valid, errors[] } (UI-ul afișează ce lipsește, tradus)
 *  altfel    → fișierul XML (attachment) sau 422 { error: "efactura_invalid", errors[] }
 *
 * Auth: sesiunea sellerului sau un link semnat (/api/seller/files/link).
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { buildEfacturaXml, validateEfacturaDocument } from "@/lib/seller/efactura/ubl";
import { fileHeaders, resolveSellerForFile } from "@/lib/seller/file-links";
import { loadSellerInvoiceDocument } from "@/lib/seller/invoice-document";
import { isUuid } from "@/lib/validation/uuid";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export const GET = withErrorHandling(async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  const sellerId = await resolveSellerForFile(req, "invoice_xml", id);
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const invoice = await loadSellerInvoiceDocument(sellerId, id);
  if (!invoice) return NextResponse.json({ success: false, error: "not_found" }, { status: 404, headers: NO_STORE });

  const errors = validateEfacturaDocument(invoice);
  if (new URL(req.url).searchParams.get("check") === "1") {
    return NextResponse.json({ success: true, valid: errors.length === 0, errors }, { headers: NO_STORE });
  }
  if (errors.length > 0) {
    return NextResponse.json({ success: false, error: "efactura_invalid", errors }, { status: 422, headers: NO_STORE });
  }

  const xml = buildEfacturaXml(invoice);
  return new Response(xml, {
    headers: fileHeaders("application/xml; charset=utf-8", `${invoice.number}-eFactura.xml`, "attachment"),
  });
});
