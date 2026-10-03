import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth/session";
import NotificationsClient from "./NotificationsClient";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await getAuthSession();
  if (!session) redirect("/auth?next=/notifications");
  return <NotificationsClient />;
}
