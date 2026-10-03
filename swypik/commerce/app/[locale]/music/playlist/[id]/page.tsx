import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import PlaylistClient from "./PlaylistClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "meta" });
    return { title: t("musicTitle"), description: t("musicDescription") };
}

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) notFound();
    const { id } = await params;
    return <PlaylistClient id={id} />;
}
