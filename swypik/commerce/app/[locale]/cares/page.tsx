import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import CaresClient from "./CaresClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "cares" });
    return {
        alternates: localizedAlternates(locale, "/cares"),
        title: t("metaTitle"),
        description: t("metaDescription"),
    };
}

// Swypik Cares e ascuns (FEATURE_CARES=off) până există un partener ONG.
export default function CaresPage() {
    if (!isEnabled("cares")) notFound();
    return <CaresClient />;
}
