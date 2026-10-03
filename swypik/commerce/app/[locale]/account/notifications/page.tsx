import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth/session";
import NotificationsSettingsClient from "./NotificationsSettingsClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getAuthSession();
  if (!session) redirect("/auth?next=/account/notifications");
  return <NotificationsSettingsClient />;
}
