import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import DriverPanel from "@/components/go/driver/DriverPanel";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("goDriver");
  return { title: t("metaTitle"), robots: { index: false } };
}

export default function CourierPage() {
  return <DriverPanel />;
}
