import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { CartView } from "@/components/shop/cart/CartView";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { getShopConfig } from "@/lib/shop/config";

export const dynamic = "force-dynamic";

export default async function CartPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "shopBuyer.cart" });
  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back title={t("title")} />
      <main className="mx-auto max-w-5xl px-gutter py-4">
        <CartView maxLineQty={getShopConfig().maxLineQty} />
      </main>
    </div>
  );
}
