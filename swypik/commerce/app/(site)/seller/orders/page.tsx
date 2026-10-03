import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { SellerOrders } from "@/components/seller/orders/SellerOrders";
import { Skeleton } from "@/components/ui/Skeleton";

export const dynamic = "force-dynamic";

/** Comenzile seller-ului: taburi pe stare, acceptare, expediere cu AWB, livrare, anulare cu refund. */
export default async function SellerOrdersPage() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect("/seller/login?next=/seller/orders");
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-card" />}>
      <SellerOrders />
    </Suspense>
  );
}
