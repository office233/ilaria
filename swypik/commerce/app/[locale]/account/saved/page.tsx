import type { Metadata } from "next";
import { redirect } from "@/lib/i18n/navigation";
import { Heart } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProductCard } from "@/components/shop/ProductCard";
import { SavedRemoveButton } from "@/components/shop/SavedRemoveButton";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { Link } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { listSavedProducts } from "@/lib/shop/saved";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shopBuyer.saved" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function SavedProductsPage({ params }: Props) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const user = await getAuthUser();
  if (!user.userId) return redirect({ href: "/account?redirect=/account/saved", locale });
  const [t, items] = await Promise.all([
    getTranslations({ locale, namespace: "shopBuyer.saved" }),
    listSavedProducts(user.userId, locale),
  ]);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/account" title={t("title")} />
      <main className="mx-auto max-w-5xl px-gutter py-4">
        {items.length === 0 ? (
          <EmptyState
            icon={Heart}
            title={t("emptyTitle")}
            description={t("emptyBody")}
            action={
              <Button asChild>
                <Link href="/shop">{t("browse")}</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((p) => (
              <li key={p.id} className="relative">
                <ProductCard product={p} className={p.available ? undefined : "opacity-60"} />
                {!p.available ? (
                  <Badge tone="neutral" className="absolute bottom-24 left-2">
                    {t("unavailable")}
                  </Badge>
                ) : null}
                <div className="absolute right-2 top-2">
                  <SavedRemoveButton productId={p.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
