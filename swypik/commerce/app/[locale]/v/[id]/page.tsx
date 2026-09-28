import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getVertical, VERTICAL_CATALOG } from "@/lib/verticals/catalog";
import VerticalClient from "./VerticalClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateStaticParams() {
    return VERTICAL_CATALOG.map((v) => ({ id: v.id }));
}

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string; locale: string }>;
}): Promise<Metadata> {
    const { id, locale } = await params;
    const v = getVertical(id);
    if (!v) return { title: "Swypik" };
    const [t, tv] = await Promise.all([
        getTranslations({ locale, namespace: "verticals" }),
        getTranslations({ locale, namespace: "vertical" }),
    ]);
    const label = t(`${v.labelKey}.label`);
    return {
        alternates: localizedAlternates(locale, `/v/${id}`),
        title: `${v.brand} — ${label} | Swypik`,
        description: tv("metaDescription", { label }),
    };
}

export default async function VerticalPage({
    params,
}: {
    params: Promise<{ id: string; locale: string }>;
}) {
    const { id } = await params;
    const vertical = getVertical(id);
    if (!vertical) notFound();

    return <VerticalClient vertical={vertical} />;
}
