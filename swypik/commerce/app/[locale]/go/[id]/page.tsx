import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { isUuidParam } from "@/lib/validation/params";
import RideScreen from "@/components/go/rider/RideScreen";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "go" });
  return { title: t("rideMetaTitle"), robots: { index: false } };
}

export default async function RidePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isEnabled("go") || !isUuidParam(id)) notFound();
  return <RideScreen rideId={id} />;
}
