import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import TrackClient from "./TrackClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "go" });
  return { title: t("trackMetaTitle"), robots: { index: false } };
}

export default async function TrackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TrackClient token={token} />;
}
