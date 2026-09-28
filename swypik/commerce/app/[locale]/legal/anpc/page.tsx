/**
 * Protecția consumatorului — ANPC, SAL și SOL.
 *
 * Afișarea acestor informații și linkuri este OBLIGATORIE pentru comercianții
 * online din România (OG 21/1992, Legea 365/2002) și din UE (Reg. 524/2013,
 * care cere link direct către platforma SOL).
 */
import type { Metadata } from "next";
import { Link } from "@/lib/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { localizedAlternates } from "@/lib/seo/hreflang";

export async function generateMetadata({
    params,
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "legalAnpc" });
    return {
        alternates: localizedAlternates(locale, "/legal/anpc"),
        title: t("metaTitle"),
        description: t("metaDescription"),
    };
}

export default async function AnpcPage() {
    const t = await getTranslations("legalAnpc");
    const CHANNELS = [
        {
            name: t("channelSupportName"),
            detail: t("channelSupportDetail"),
            action: SUPPORT_EMAIL,
            href: `mailto:${SUPPORT_EMAIL}`,
            note: t("channelSupportNote"),
        },
        {
            name: t("channelAnpcName"),
            detail: t("channelAnpcDetail"),
            action: "anpc.ro",
            href: "https://anpc.ro",
            note: t("channelAnpcNote"),
        },
        {
            name: t("channelSalName"),
            detail: t("channelSalDetail"),
            action: "anpc.ro/ce-este-sal",
            href: "https://anpc.ro/ce-este-sal/",
            note: t("channelSalNote"),
        },
        {
            name: t("channelSolName"),
            detail: t("channelSolDetail"),
            action: "ec.europa.eu/consumers/odr",
            href: "https://ec.europa.eu/consumers/odr",
            note: t("channelSolNote"),
        },
    ];
    return (
        <main className="mx-auto max-w-2xl px-4 pb-24 pt-8">
            <h1 className="text-2xl font-black">{t("title")}</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                {t("intro")}
            </p>

            <h2 className="mt-8 text-lg font-bold">{t("whereTitle")}</h2>
            <div className="mt-3 space-y-3">
                {CHANNELS.map((c) => (
                    <a
                        key={c.name}
                        href={c.href}
                        target={c.href.startsWith("http") ? "_blank" : undefined}
                        rel="noreferrer"
                        className="block rounded-2xl border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900"
                    >
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-bold">{c.name}</span>
                            <span className="text-xs font-semibold text-sky-600">{c.action}</span>
                        </div>
                        <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{c.detail}</p>
                        <p className="mt-1 text-xs text-neutral-500">{c.note}</p>
                    </a>
                ))}
            </div>

            <h2 className="mt-8 text-lg font-bold">{t("rightsTitle")}</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] text-neutral-700 dark:text-neutral-300">
                <li>
                    <strong>{t("r1Strong")}</strong>{t("r1Text")}
                    <Link href="/terms#retragere" className="underline">{t("r1Link")}</Link>.
                </li>
                <li>
                    <strong>{t("r2Strong")}</strong>{t("r2Text")}
                </li>
                <li>
                    <strong>{t("r3Strong")}</strong>{t("r3Text")}
                </li>
                <li>
                    <strong>{t("r4Strong")}</strong>{t("r4Text")}
                </li>
            </ul>

            <div className="mt-8 rounded-xl bg-neutral-50 p-4 text-sm dark:bg-neutral-900">
                <p className="font-semibold">{t("operatorTitle")}</p>
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                    Swypik Technology · {SUPPORT_EMAIL}
                </p>
                <p className="mt-2 flex flex-wrap gap-3 text-xs">
                    <Link href="/terms" className="underline">{t("linkTerms")}</Link>
                    <Link href="/privacy" className="underline">{t("linkPrivacy")}</Link>
                    <Link href="/legal/cookies" className="underline">{t("linkCookies")}</Link>
                </p>
            </div>
        </main>
    );
}
