import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import AnalyticsClient from "./AnalyticsClient";

export const dynamic = "force-dynamic";

export default async function CreatorAnalyticsPage() {
  const auth = await getAuthUser();
  if (auth.role !== "creator" && auth.role !== "admin") {
    redirect("/creator");
  }
  return <AnalyticsClient />;
}
