/**
 * Contoare atomice per seller (numere de factură, de bon POS etc.).
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` este atomic în Postgres:
 * două cereri concurente primesc valori diferite fără lock explicit. Se apelează
 * din interiorul tranzacției care scrie documentul, ca numărul să nu fie
 * consumat dacă inserarea documentului eșuează.
 */
import type { TxQuery } from "@/lib/db";

export type SellerSequenceKind = "invoice" | "pos_receipt";

export async function nextSellerSequence(
    q: TxQuery,
    sellerId: string,
    kind: SellerSequenceKind,
    series = "",
): Promise<number> {
    const { rows } = await q<{ value: number }>(
        `INSERT INTO seller_sequences (seller_id, kind, series, value)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (seller_id, kind, series)
         DO UPDATE SET value = seller_sequences.value + 1, updated_at = now()
         RETURNING value`,
        [sellerId, kind, series],
    );
    return Number(rows[0].value);
}
