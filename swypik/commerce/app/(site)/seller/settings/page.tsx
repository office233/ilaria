import { dbQuery } from "@/lib/db";
import { redirect } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { APP_URL } from "@/lib/app-url";
import { requireSellerPage, sellerLoginPath } from "@/lib/seller/page-auth";
import { sellerCommissionBps } from "@/lib/seller/config";
import { INVOICE_DEFAULT_SERIES } from "@/lib/seller/invoicing";
import { sellerFiscalProfileFromRow } from "@/lib/seller/fiscal-profile";
import { normalizeRoCounty } from "@/lib/seller/efactura/counties";
import SellerSettingsClient from "./SellerSettingsClient";

export const dynamic = "force-dynamic";

export default async function SellerSettingsPage() {
  const sellerId = await requireSellerPage("/seller/settings");

  const { rows } = await dbQuery<{
    id: string;
    name: string;
    email: string;
    cui: string | null;
    phone: string | null;
    business_details: Record<string, unknown> | null;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    bio: string | null;
  }>(
    `SELECT s.id, s.name, s.email, s.cui, s.phone, s.business_details,
            u.username, u.display_name, u.avatar_url, u.bio
       FROM sellers s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [sellerId],
  );

  const seller = rows[0];
  if (!seller) redirect(sellerLoginPath("/seller/settings"));

  const bd = seller.business_details ?? {};
  const fiscal = sellerFiscalProfileFromRow(seller);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const format = await getFormatter();

  return (
    <SellerSettingsClient
      commissionPct={format.number(sellerCommissionBps() / 10_000, { style: "percent", maximumFractionDigits: 2 })}
      publicHost={new URL(APP_URL).host}
      initialData={{
        sellerId: seller.id,
        name: seller.display_name || seller.name || "",
        username: seller.username || "",
        email: seller.email || "",
        bio: seller.bio || str(bd.description),
        avatarUrl: seller.avatar_url || "",
        cui: seller.cui || "",
        phone: seller.phone || "",
        iban: fiscal.iban ?? "",
        invoiceSeries: str(bd.invoiceSeries) || INVOICE_DEFAULT_SERIES,
        legalName: str(bd.legalName),
        tradeRegister: fiscal.tradeRegister ?? "",
        street: fiscal.address.street,
        city: fiscal.address.city,
        county: normalizeRoCounty(fiscal.address.county) ?? "",
        postalCode: fiscal.address.postalCode ?? "",
        country: fiscal.address.country,
        vatExemptionReason: fiscal.vatExemptionReason ?? "",
      }}
    />
  );
}
