import { Package } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import type { PromotedProduct } from "@/lib/social/user-profile";

function formatPrice(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Carusel orizontal cu produsele promovate de creator (server). */
export async function PromotedProducts({ locale, products }: { locale: string; products: PromotedProduct[] }) {
  if (products.length === 0) return null;
  const t = await getTranslations({ locale, namespace: "userProfile" });
  const ts = await getTranslations({ locale, namespace: "social.profile" });
  return (
    <section className="px-gutter">
      <h2 className="mb-3 text-base font-semibold text-fg">{t("promotedProducts")}</h2>
      <ul className="no-scrollbar -mx-gutter flex gap-3 overflow-x-auto px-gutter pb-1">
        {products.map((p) => (
          <li key={p.id} className="w-32 shrink-0">
            <Link href={`/product/${encodeURIComponent(p.id)}`} className="block rounded-card border border-subtle bg-surface p-2 hover:bg-surface-2">
              <span className="mb-2 block aspect-square overflow-hidden rounded-control bg-surface-2">
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- imagini de produs din domenii externe
                  <img src={p.imageUrl} alt={p.title ?? ts("productAlt")} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="grid h-full w-full place-items-center text-subtle">
                    <Package aria-hidden className="h-6 w-6" />
                  </span>
                )}
              </span>
              <span className="line-clamp-2 text-xs font-semibold text-fg">{p.title ?? ts("productAlt")}</span>
              {p.priceCents !== null ? (
                <span className="mt-1 block text-xs font-bold text-brand">{formatPrice(p.priceCents, p.currency, locale)}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
