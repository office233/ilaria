/**
 * Politica de confidențialitate — randată din lib/legal/privacy-content.ts
 * (sursă unică de adevăr, ținută sincron cu ce colectează efectiv platforma).
 */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PRIVACY_SECTIONS, PRIVACY_LAST_UPDATED } from "@/lib/legal/privacy-content";
import { localizedAlternates } from "@/lib/seo/hreflang";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
    const { locale } = await params;
    const [t, tm] = await Promise.all([
        getTranslations({ locale, namespace: "legalPrivacy" }),
        getTranslations({ locale, namespace: "meta" }),
    ]);
    return {
        title: `${t("title")} — Swypik`,
        description: tm("privacyDescription"),
        alternates: localizedAlternates(locale, "/privacy"),
    };
}

export default async function PrivacyPage() {
    const tx = await getTranslations("privacy");
    const t = await getTranslations("legalPrivacy");
    return (
        <main className="mx-auto max-w-2xl px-4 pb-24 pt-8">
            <h1 className="text-2xl font-black">{t("title")}</h1>
            <p className="mt-1 text-sm text-neutral-500">{t("lastUpdated", { date: PRIVACY_LAST_UPDATED })}</p>

            <p className="mt-4 rounded-xl bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200">
                {t("summary")}
            </p>

            <div className="mt-8 space-y-8">
                {PRIVACY_SECTIONS.map((s) => (
                    <section key={s.id} id={s.id}>
                        <h2 className="text-lg font-bold">{s.title}</h2>

                        {s.body?.map((p, i) => (
                            <p key={i} className="mt-2 text-[15px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                                {p}
                            </p>
                        ))}

                        {s.bullets && (
                            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] text-neutral-700 dark:text-neutral-300">
                                {s.bullets.map((b, i) => <li key={i}>{b}</li>)}
                            </ul>
                        )}

                        {s.table && (
                            <div className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
                                        <tr>
                                            {s.table.headers.map((h) => (
                                                <th key={h} className="px-3 py-2 font-bold">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                                        {s.table.rows.map((row, i) => (
                                            <tr key={i}>
                                                {row.map((cell, j) => (
                                                    <td key={j} className={`px-3 py-2 ${j === 0 ? "font-medium" : "text-neutral-600 dark:text-neutral-400"}`}>
                                                        {cell}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                ))}
            </div>

            <p className="mt-10 border-t border-neutral-200 pt-4 text-xs text-neutral-400 dark:border-neutral-800">
                {tx("swypikTechnologyPrivacyswypikcomAutoritatea")}
            </p>
        </main>
    );
}
