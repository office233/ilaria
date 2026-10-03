import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { staysConfig } from "@/lib/stays/config";
import HostPanelClient from "./HostPanelClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "staysHost" });
    return { title: t("metaTitle"), robots: { index: false } };
}

export default function HostPanelPage() {
    return (
        <HostPanelClient
            limits={{
                maxNights: staysConfig.maxNights(),
                maxGuests: staysConfig.maxGuests(),
                maxPhotos: staysConfig.maxPhotos(),
                minPriceCents: staysConfig.minPricePerNightCents(),
                maxPriceCents: staysConfig.maxPricePerNightCents(),
            }}
        />
    );
}
