import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import CreateFlow from "@/components/upload/CreateFlow";
import { guardCreatePage } from "@/components/upload/createPageGuard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "videoUpload" });
  return { title: t("recordPageTitle"), robots: { index: false } };
}

/** Butonul „Creează” din BottomNav: același flux ca /upload, pornit direct pe cameră. */
export default async function ReelsRecordPage({ params }: Props) {
  const { locale } = await params;
  await guardCreatePage(locale, "/reels/record");
  return <CreateFlow initialSource="camera" />;
}
