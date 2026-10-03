import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shopBuyer.cart" });
  return { title: t("metaTitle"), robots: { index: false, follow: true } };
}

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
