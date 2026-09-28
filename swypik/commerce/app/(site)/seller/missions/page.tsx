import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { missionLimits } from "@/lib/missions/config";
import { SellerMissionsClient } from "./_components/SellerMissionsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("sellerMissions");
  return { title: t("metaTitle") };
}

export default async function SellerMissionsPage() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect("/seller/login");

  return <SellerMissionsClient limits={missionLimits()} />;
}
