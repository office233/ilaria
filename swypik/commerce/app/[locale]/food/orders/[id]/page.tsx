import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import OrderTrackingClient from "./OrderTrackingClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "food" });
  return {
    title: `${t("meta.trackingTitle")} | Swypik Food`,
    description: t("meta.trackingDescription"),
    robots: { index: false, follow: false },
  };
}

export default async function OrderTrackingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OrderTrackingClient orderId={id} />;
}
