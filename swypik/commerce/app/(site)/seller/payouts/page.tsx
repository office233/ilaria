import { redirect } from "next/navigation";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { SellerPayouts } from "@/components/seller/payouts/SellerPayouts";

export const dynamic = "force-dynamic";

/** Sold și retrageri: Stripe Connect doar cu flag + chei, altfel transfer bancar aprobat în admin. */
export default async function SellerPayoutsPage() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect("/seller/login?next=/seller/payouts");
  return <SellerPayouts />;
}
