/**
 * Profilul fiscal al sellerului (furnizorul de pe facturi / expeditorul de pe AWB),
 * citit din `sellers` (name, cui, email, phone) + `business_details` (jsonb):
 *   legalName, address, city, county, postalCode, country, tradeRegister,
 *   iban, vatExemptionReason.
 * Nimic nu se completează cu valori inventate: câmpurile lipsă rămân goale și
 * sunt raportate de validarea e-Factura.
 */
import { dbQuery } from "@/lib/db";
import type { EfacturaSupplier } from "./efactura/ubl";

export type SellerRow = {
  name: string | null;
  cui: string | null;
  email: string | null;
  phone: string | null;
  business_details: Record<string, unknown> | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function sellerFiscalProfileFromRow(row: SellerRow | null | undefined): EfacturaSupplier {
  const bd = row?.business_details ?? {};
  return {
    legalName: str(bd.legalName) || str(row?.name),
    cui: str(row?.cui) || str(bd.cui),
    tradeRegister: str(bd.tradeRegister) || null,
    address: {
      street: str(bd.address) || str(bd.street),
      city: str(bd.city),
      county: str(bd.county) || str(bd.state),
      postalCode: str(bd.postalCode) || null,
      country: (str(bd.country) || "RO").toUpperCase(),
    },
    iban: str(bd.iban) || null,
    vatExemptionReason: str(bd.vatExemptionReason) || null,
    email: str(row?.email) || null,
    phone: str(row?.phone) || null,
  };
}

export async function loadSellerFiscalProfile(sellerId: string): Promise<EfacturaSupplier> {
  const { rows } = await dbQuery<SellerRow>(
    `SELECT name, cui, email, phone, business_details FROM sellers WHERE id = $1 LIMIT 1`,
    [sellerId],
  );
  return sellerFiscalProfileFromRow(rows[0]);
}
