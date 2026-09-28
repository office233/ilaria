import { getTranslations } from "next-intl/server";
import MerchantPanelClient from "./MerchantPanelClient";

export async function generateMetadata() {
  const t = await getTranslations("sellerMerchant");
  return { title: t("pageTitle") };
}

export default function MerchantPanelPage() {
  return <MerchantPanelClient />;
}
