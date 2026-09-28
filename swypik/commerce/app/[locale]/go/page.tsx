import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { Suspense } from "react";
import RequestScreen from "@/components/go/rider/RequestScreen";
import PermissionsPrompt from "@/components/pwa/PermissionsPrompt";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("goTitle"), description: t("goDescription"), alternates: localizedAlternates(locale, "/go") };
}

export default function GoPage() {
  if (!isEnabled("go")) notFound();
  return (
    <>
      <Suspense>
        <RequestScreen />
      </Suspense>
      <PermissionsPrompt vertical="go" />
    </>
  );
}
