import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { CheckoutView } from "@/components/shop/checkout/CheckoutView";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";

export default async function CheckoutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "shopBuyer.checkout" });
  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/cart" title={t("title")} />
      <main className="mx-auto max-w-5xl px-gutter py-4">
        <CheckoutView />
      </main>
    </div>
  );
}
