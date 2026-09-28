import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import OrdersListClient from "./OrdersListClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "food" });
  return {
    title: `${t("orders.title")} | Swypik Food`,
    description: t("meta.ordersDescription"),
    robots: { index: false, follow: false },
  };
}

export default function OrdersPage() {
  return <OrdersListClient />;
}
