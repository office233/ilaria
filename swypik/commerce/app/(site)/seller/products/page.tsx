import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { SellerProducts } from "@/components/seller/products/SellerProducts";
import { Skeleton } from "@/components/ui/Skeleton";

export const dynamic = "force-dynamic";

/** Catalogul seller-ului: adăugare + editare (preț, stoc, imagini, categorie, variante), arhivare. */
export default async function SellerProductsPage() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect("/seller/login?next=/seller/products");
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-card" />}>
      <SellerProducts />
    </Suspense>
  );
}
