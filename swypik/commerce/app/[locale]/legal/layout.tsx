import { Link } from "@/lib/i18n/navigation";
import { getTranslations } from "next-intl/server";
export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("legalLayout");
  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto px-4 py-10 pb-24 prose prose-neutral dark:prose-invert prose-headings:font-bold prose-h1:text-3xl prose-h2:text-xl prose-h2:mt-8">
        {children}
        <div className="mt-12 pt-6 border-t border-neutral-200 dark:border-neutral-800 text-sm flex gap-4 flex-wrap">
          <Link href="/legal/terms" className="underline">{t("terms")}</Link>
          <Link href="/legal/privacy" className="underline">{t("privacy")}</Link>
          <Link href="/legal/cookies" className="underline">{t("cookies")}</Link>
          <Link href="/legal/anpc" className="underline">{t("anpc")}</Link>
          <Link href="/" className="underline">{t("backHome")}</Link>
        </div>
      </div>
    </div>
  );
}
