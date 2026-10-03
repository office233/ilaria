/**
 * Factura unui seller ca document e-Factura (furnizor + client + linii), din DB.
 * Furnizorul = instantaneul salvat la emitere (`supplier_snapshot`) sau, pentru
 * facturile vechi, profilul fiscal curent al sellerului.
 */
import { dbQuery } from "@/lib/db";
import { loadSellerFiscalProfile } from "./fiscal-profile";
import { efacturaIssueDate, type EfacturaAddress, type EfacturaInvoice, type EfacturaSupplier } from "./efactura/ubl";

type InvoiceRow = {
  id: string;
  invoice_number: string;
  created_at: string;
  currency: string | null;
  vat_rate_pct: string | number;
  status: string;
  subtotal_cents: string | number;
  vat_cents: string | number;
  total_cents: string | number;
  items: Array<{ title?: unknown; quantity?: unknown; price?: unknown }> | null;
  client_name: string;
  client_cui: string | null;
  client_address: string | null;
  client_details: Record<string, unknown> | null;
  supplier_snapshot: EfacturaSupplier | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Adresa structurată a clientului, sau null dacă lipsește strada (facturi vechi). */
export function clientAddressFromDetails(details: Record<string, unknown> | null | undefined): EfacturaAddress | null {
  const d = details ?? {};
  if (!str(d.street)) return null;
  return {
    street: str(d.street),
    city: str(d.city),
    county: str(d.county),
    postalCode: str(d.postalCode) || null,
    country: (str(d.country) || "RO").toUpperCase(),
  };
}

export async function loadSellerInvoiceDocument(sellerId: string, invoiceId: string): Promise<EfacturaInvoice | null> {
  const { rows } = await dbQuery<InvoiceRow>(
    `SELECT id, invoice_number, created_at, currency, vat_rate_pct, status,
            subtotal_cents, vat_cents, total_cents, items,
            client_name, client_cui, client_address, client_details, supplier_snapshot
       FROM seller_invoices
      WHERE id = $1 AND seller_id = $2
      LIMIT 1`,
    [invoiceId, sellerId],
  );
  const row = rows[0];
  if (!row) return null;
  const supplier = row.supplier_snapshot ?? (await loadSellerFiscalProfile(sellerId));
  return {
    number: row.invoice_number,
    issueDate: efacturaIssueDate(row.created_at),
    currency: (row.currency || "RON").toUpperCase(),
    vatRatePct: Number(row.vat_rate_pct) || 0,
    status: row.status,
    subtotalCents: Number(row.subtotal_cents) || 0,
    vatCents: Number(row.vat_cents) || 0,
    totalCents: Number(row.total_cents) || 0,
    items: (row.items ?? []).map((i) => ({
      title: str(i.title),
      quantity: Number(i.quantity) || 1,
      price: Number(i.price) || 0,
    })),
    supplier,
    customer: {
      name: row.client_name,
      cui: row.client_cui,
      address: clientAddressFromDetails(row.client_details),
      addressText: row.client_address,
    },
  };
}
