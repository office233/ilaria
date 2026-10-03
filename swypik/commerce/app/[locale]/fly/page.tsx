import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { isFlyBookingEnabled } from "@/lib/fly/gate";
import FlyClient from "./FlyClient";
import FlyComingSoon from "./FlyComingSoon";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    if (!isFlyBookingEnabled()) {
        const t = await getTranslations({ locale, namespace: "flyWaitlist" });
        return { title: t("metaTitle"), description: t("metaDescription"), alternates: localizedAlternates(locale, "/fly") };
    }
    const t = await getTranslations({ locale, namespace: "fly" });
    return { title: t("metaTitle"), description: t("metaDescription"), alternates: localizedAlternates(locale, "/fly") };
}

/**
 * Fără furnizor de zboruri contractat, /fly e o pagină onestă „în curând /
 * anunță-mă” — fără zboruri, prețuri sau destinații cu prețuri inventate.
 * Căutarea/rezervarea (FlyClient) revine doar cu FEATURE_FLY_BOOKING=1.
 */
export default function FlyPage() {
    return isFlyBookingEnabled() ? <FlyClient /> : <FlyComingSoon />;
}
