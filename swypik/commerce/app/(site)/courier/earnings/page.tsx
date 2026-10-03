import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import EarningsClient from "./EarningsClient";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("courierEarnings");
    return { title: t("metaTitle"), robots: { index: false } };
}

export default function CourierEarningsPage() {
    return <EarningsClient />;
}
