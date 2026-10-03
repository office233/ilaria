import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery, withTransaction } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { nextSellerSequence } from "@/lib/seller/sequences";
import { loadSellerFiscalProfile } from "@/lib/seller/fiscal-profile";
import { normalizeRoCounty } from "@/lib/seller/efactura/counties";
import {
  INVOICE_DEFAULT_SERIES,
  RO_VAT_RATES,
  RO_VAT_STANDARD_PCT,
  computeInvoiceTotals,
  formatInvoiceNumber,
} from "@/lib/seller/invoicing";

export const dynamic = "force-dynamic";

const INVOICES_PAGE_SIZE = 100;

const InvoiceLineSchema = z.object({
  title: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().int().min(1).max(10_000).default(1),
  price: z.coerce.number().min(0).max(1_000_000),
});

const CreateInvoiceSchema = z.object({
  clientId: z.string().uuid().optional(),
  clientName: z.string().trim().min(1).max(200),
  clientCui: z.string().trim().max(32).optional(),
  clientAddress: z.string().trim().max(500).optional(),
  // Adresa structurată (CIUS-RO): stradă, oraș, județ ISO, cod poștal, țară.
  clientStreet: z.string().trim().max(200).optional(),
  clientCity: z.string().trim().max(100).optional(),
  clientCounty: z.string().trim().max(64).optional(),
  clientPostalCode: z.string().trim().max(16).optional(),
  clientCountry: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default("RO"),
  items: z.array(InvoiceLineSchema).min(1),
  series: z.string().trim().min(1).max(16).regex(/^[A-Za-z0-9-]+$/).default(INVOICE_DEFAULT_SERIES),
  status: z.enum(["draft", "issued", "paid"]).default("issued"),
  vatRate: z.coerce.number().refine((v) => (RO_VAT_RATES as readonly number[]).includes(v))
    .default(RO_VAT_STANDARD_PCT),
});

export const GET = withErrorHandling(async function GET() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const { rows } = await dbQuery(
    `SELECT id, series, number, invoice_number, client_name, client_cui,
            subtotal_cents, vat_cents, total_cents, vat_rate_pct, currency,
            status, efactura_status, created_at
       FROM seller_invoices
      WHERE seller_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sellerId, INVOICES_PAGE_SIZE],
  );

  return NextResponse.json({ success: true, invoices: rows });
});

export const POST = withErrorHandling(async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("sellerInvoices", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = parseBody(CreateInvoiceSchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: "validation_error", issues: parsed.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // IDOR guard: `clientId` is client-supplied — verify it actually belongs to this
  // seller's own client book before trusting it (audit 2026-09-24, wave2-misc).
  if (input.clientId) {
    const { rows: clientRows } = await dbQuery(
      `SELECT 1 FROM seller_clients WHERE id = $1 AND seller_id = $2`,
      [input.clientId, sellerId],
    );
    if (clientRows.length === 0) {
      return NextResponse.json({ success: false, error: "invalid_client" }, { status: 400 });
    }
  }

  const totals = computeInvoiceTotals(input.items, input.vatRate);
  // Furnizorul se „îngheață” la emitere: o factură nu se schimbă când sellerul
  // își modifică ulterior adresa sau CUI-ul.
  const supplier = await loadSellerFiscalProfile(sellerId);
  const clientDetails = {
    street: input.clientStreet || "",
    city: input.clientCity || "",
    county: normalizeRoCounty(input.clientCounty) ?? input.clientCounty ?? "",
    postalCode: input.clientPostalCode || "",
    country: input.clientCountry,
  };
  const clientAddressText =
    input.clientAddress ||
    [clientDetails.street, clientDetails.postalCode, clientDetails.city, clientDetails.county, clientDetails.country]
      .filter(Boolean)
      .join(", ");

  // Numărul se consumă în aceeași tranzacție cu inserarea: fără goluri la eroare,
  // fără duplicate sub concurență (contor atomic, UNIQUE pe seller+serie+număr).
  type InsertedInvoice = {
    id: string;
    series: string;
    number: number;
    invoice_number: string;
    client_name: string;
    client_cui: string | null;
    subtotal_cents: number;
    vat_cents: number;
    total_cents: number;
    status: string;
    efactura_status: string;
    created_at: string;
  };
  const invoice = await withTransaction(async (q) => {
    const number = await nextSellerSequence(q, sellerId, "invoice", input.series);
    const { rows } = await q<InsertedInvoice>(
      `INSERT INTO seller_invoices (
         seller_id, client_id, series, number, invoice_number,
         client_name, client_cui, client_address,
         items, vat_rate_pct, subtotal_cents, vat_cents, total_cents, status,
         client_details, supplier_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)
       RETURNING id, series, number, invoice_number, client_name, client_cui,
                 subtotal_cents, vat_cents, total_cents, status, efactura_status, created_at`,
      [
        sellerId,
        input.clientId ?? null,
        input.series,
        number,
        formatInvoiceNumber(input.series, number),
        input.clientName,
        input.clientCui || null,
        clientAddressText || null,
        JSON.stringify(input.items),
        input.vatRate,
        totals.subtotalCents,
        totals.vatCents,
        totals.totalCents,
        input.status,
        JSON.stringify(clientDetails),
        JSON.stringify(supplier),
      ],
    );
    return rows[0];
  });

  return NextResponse.json({ success: true, invoice }, { status: 201 });
});
