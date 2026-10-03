import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth/session";
import AddressesClient from "./AddressesClient";

export const dynamic = "force-dynamic";

export default async function AddressesPage() {
  const session = await getAuthSession();
  if (!session) redirect("/auth/login?next=/account/addresses");
  return <AddressesClient />;
}
