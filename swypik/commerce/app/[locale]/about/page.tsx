import { Link } from "@/lib/i18n/navigation";
import type { Metadata } from "next";
import { localizedAlternates } from "@/lib/seo/hreflang";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { HELLO_EMAIL, SUPPORT_EMAIL } from "@/lib/contact";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: t("aboutTitle"),
    description: t("aboutDescription"),
    alternates: localizedAlternates(locale, "/about"),
  };
}

export default function AboutPage() {
  const t = useTranslations("about");
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold mb-4">{t("aboutTitle")}</h1>
      <p className="text-zinc-700 mb-6">

        {t("swypikEstePlatformaRomaneasca")}
      </p>

      <h2 className="text-xl font-semibold mt-8 mb-3">{t("whatWeDoDifferently")}</h2>
      <ul className="list-disc pl-6 space-y-2 text-zinc-700">
        <li><strong>{t("featureAi")}</strong>  {t("fiecareProdusPrimesteUn")}</li>
        <li><strong>{t("featureVideo")}</strong>  {t("veziProdusulInActiune")}</li>
        <li><strong>{t("featureCreators")}</strong>  {t("sprijinimCreatoriiRomaniCare")}</li>
        <li><strong>{t("featureCommunity")}</strong>  {t("voteazaMeritaSauNu")}</li>
      </ul>

      <h2 className="text-xl font-semibold mt-8 mb-3">{t("cumFunctioneaza")}</h2>
      <ol className="list-decimal pl-6 space-y-2 text-zinc-700">
        <li>{t("descoperiUnProdusIntrun")} <Link href="/explore" className="underline">/explore</Link>.</li>
        <li>{t("verificiScorulSwypikRecenziile")}</li>
        <li>{t("adaugiInCosSi")}</li>
        <li>{t("primestiProdusulIn514")}</li>
      </ol>

      <h2 className="text-xl font-semibold mt-8 mb-3">{t("contact")}</h2>
      <p className="text-zinc-700">
        {t("emailLabel")} <a className="underline" href={`mailto:${HELLO_EMAIL}`}>{HELLO_EMAIL}</a><br />
        {t("supportLabel")} <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>

      <div className="mt-10 flex flex-wrap gap-4 text-sm">
        <Link href="/help" className="underline">{t("help")}</Link>
        <Link href="/terms" className="underline">{t("terms")}</Link>
        <Link href="/privacy" className="underline">{t("confidentialitate")}</Link>
        <Link href="/become-a-creator" className="underline">{t("becomeCreator")}</Link>
        <Link href="/become-a-seller" className="underline">{t("becomeSeller")}</Link>
      </div>
    </main>
  );
}
