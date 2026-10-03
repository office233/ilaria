/**
 * Facturare seller — calcule pure, fără DB.
 *
 * Cotele de TVA sunt cele legale din România de la 1 aug 2025 (OUG 22/2025):
 * standard 21%, redusă 11%. Se schimbă rar, dar când se schimbă, aici e
 * singurul loc de modificat; rutele și testele importă de aici.
 */

export const RO_VAT_STANDARD_PCT = 21;
export const RO_VAT_REDUCED_PCT = 11;
export const RO_VAT_RATES = [0, RO_VAT_REDUCED_PCT, RO_VAT_STANDARD_PCT] as const;

export const INVOICE_DEFAULT_SERIES = "FACT";
export const INVOICE_NUMBER_PAD = 4;

export type InvoiceLineInput = {
    title: string;
    quantity: number;
    /** Preț unitar cu TVA inclus, în unitatea monedei (ex. RON). */
    price: number;
};

export type InvoiceTotals = {
    subtotalCents: number;
    vatCents: number;
    totalCents: number;
};

/** Cenți întregi dintr-o sumă în unitatea monedei, fără eroare de virgulă mobilă. */
export function toCents(amount: number): number {
    return Math.round((Number(amount) || 0) * 100);
}

/**
 * Prețurile introduse de seller sunt CU TVA inclus (așa se afișează la raft);
 * baza impozabilă se extrage prin împărțire, iar TVA-ul e diferența — astfel
 * subtotal + TVA == total exact, în cenți.
 */
export function computeInvoiceTotals(items: InvoiceLineInput[], vatRatePct: number): InvoiceTotals {
    const totalCents = items.reduce((sum, item) => {
        const qty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
        return sum + toCents(item.price) * qty;
    }, 0);
    const subtotalCents = vatRatePct > 0 ? Math.round(totalCents / (1 + vatRatePct / 100)) : totalCents;
    return { subtotalCents, vatCents: totalCents - subtotalCents, totalCents };
}

export function formatInvoiceNumber(series: string, nextNumber: number): string {
    return `${series.trim()}-${String(nextNumber).padStart(INVOICE_NUMBER_PAD, "0")}`;
}

export function formatReceiptNumber(date: Date, nextNumber: number): string {
    const day = date.toISOString().slice(0, 10).replace(/-/g, "");
    return `POS-${day}-${String(nextNumber).padStart(INVOICE_NUMBER_PAD, "0")}`;
}

/**
 * Escapes XML special characters in seller/client-supplied text (nume client,
 * CUI, adresă etc.) before it's interpolated into the e-Factura UBL 2.1 XML
 * generat client-side. Fără asta, un nume de client cu `&`, `<` sau `"` rupe
 * structura XML (sau, în teorie, permite XML injection în documentul descărcat).
 */
export function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
