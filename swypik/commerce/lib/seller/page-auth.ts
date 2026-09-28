import { redirect } from "next/navigation";
import { getSellerSessionId } from "@/lib/security/seller-auth";

/** Calea de login a panoului, cu întoarcere la pagina cerută (doar căi interne /seller). */
export function sellerLoginPath(next: string): string {
  const safe = next.startsWith("/seller") && !next.startsWith("//") ? next : "/seller";
  return `/seller/login?next=${encodeURIComponent(safe)}`;
}

/** Sesiunea sellerului pentru o pagină server; fără sesiune → login cu `?next`. */
export async function requireSellerPage(path: string): Promise<string> {
  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect(sellerLoginPath(path));
  return sellerId;
}
