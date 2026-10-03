import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ApplyFormClient from "./ApplyFormClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "foodApply" });
  return {
    alternates: localizedAlternates(locale, "/food/aplica"),
    title: `${t("title")} | Swypik Food`,
    description: t("subtitle"),
  };
}

export default async function FoodAplicaPage() {
  const t = await getTranslations("foodApply");
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-3xl font-black text-fg dark:text-white">{t("title")}</h1>
      <p className="mt-2 text-[15px] text-muted dark:text-subtle">{t("subtitle")}</p>
      <ApplyFormClient />
    </div>
  );
}
