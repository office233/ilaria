import { redirect } from "next/navigation";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { getSellerDashboard } from "@/lib/seller/dashboard";
import { SellerDashboard } from "@/components/seller/dashboard/SellerDashboard";

export const dynamic = "force-dynamic";

export default async function SellerPage() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect("/seller/login?next=/seller");
  const data = await getSellerDashboard(sellerId);
  return <SellerDashboard data={data} />;
}
