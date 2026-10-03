import { Link } from "@/lib/i18n/navigation";
import type { Metadata } from "next";
import { localizedAlternates } from "@/lib/seo/hreflang";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { SUPPORT_EMAIL } from "@/lib/contact";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: t("helpTitle"),
    description: t("helpDescription"),
    alternates: localizedAlternates(locale, "/help"),
  };
}

const FAQ_KEYS = ["cumpar", "livrare", "retur", "creator", "plati"] as const;

export default function HelpPage() {
  const t = useTranslations("help");
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold mb-2">{t("ajutorIntrebariFrecvente")}</h1>
      <p className="text-zinc-600 mb-8">{t("nuGasestiCeAi")} <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      <div className="space-y-4">
        {FAQ_KEYS.map((k) => (
          <details key={k} className="rounded-lg border border-zinc-200 bg-white p-4">
            <summary className="cursor-pointer font-medium">{t(`faq.${k}.q` as Parameters<typeof t>[0])}</summary>
            <p className="mt-2 text-zinc-700">{t(`faq.${k}.a` as Parameters<typeof t>[0])}</p>
          </details>
        ))}
      </div>
      <div className="mt-10 flex flex-wrap gap-4 text-sm">
        <Link href="/terms" className="underline">{t("termeni")}</Link>
        <Link href="/privacy" className="underline">{t("confidentialitate")}</Link>
        <Link href="/account/returns" className="underline">{t("retururi")}</Link>
        <Link href="/about" className="underline">{t("despreSwypik")}</Link>
      </div>
    </main>
  );
}
