"use client";

import { ChevronRight, Store, Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Link } from "@/lib/i18n/navigation";
import type { ProductDetail } from "@/lib/products/get-product-detail";

type Product = ProductDetail["product"];

const ATTRIBUTES = [
  ["attrBrand", "brand"],
  ["attrMaterial", "material"],
  ["attrFabric", "fabricType"],
  ["attrStyle", "style"],
  ["attrPattern", "patternType"],
  ["attrSeason", "season"],
  ["attrNeckline", "neckline"],
  ["attrSleeve", "sleeveStyle"],
  ["attrSilhouette", "silhouette"],
  ["attrWaistline", "waistline"],
] as const;

function plain(html: string | null): string {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Tab-ul „Detalii”: descriere, livrare (doar date reale), atribute, vânzător. */
export function ProductDetails({ product }: { product: Product }) {
  const t = useTranslations("shopBuyer.product");
  const description = plain(product.description);
  const attributes = ATTRIBUTES.map(([key, field]) => {
    const value = product[field];
    return value && value !== "NONE" ? ([key, String(value)] as const) : null;
  }).filter((x): x is readonly [(typeof ATTRIBUTES)[number][0], string] => x !== null);
  const hasDelivery = product.shipDaysMin != null && product.shipDaysMax != null;

  return (
    <div className="space-y-4">
      {description ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-fg">{t("description")}</h3>
          <p className="whitespace-pre-line text-sm leading-relaxed text-muted">{description}</p>
        </section>
      ) : null}

      {product.shipFree || hasDelivery ? (
        <Card variant="muted" padding="md" className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Truck className="h-4 w-4" aria-hidden />
            {t("shipping")}
          </p>
          {product.shipFree ? <p className="text-sm text-muted">{t("shippingFree")}</p> : null}
          {hasDelivery ? (
            <p className="text-sm text-muted">
              {t("deliveryEstimate", { min: product.shipDaysMin ?? 0, max: product.shipDaysMax ?? 0 })}
            </p>
          ) : null}
        </Card>
      ) : null}

      {attributes.length > 0 ? (
        <Card padding="md">
          <h3 className="mb-2 text-sm font-semibold text-fg">{t("details")}</h3>
          <dl className="divide-y divide-subtle text-sm">
            {attributes.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4 py-2">
                <dt className="text-muted">{t(key)}</dt>
                <dd className="text-right font-medium text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}

      {product.seller ? (
        <Card padding="none">
          <Link
            href={`/sellers/${product.seller.id}`}
            className="flex min-h-[3.5rem] items-center gap-3 rounded-card px-4 py-3 hover:bg-surface-2"
          >
            <Store className="h-5 w-5 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">{t("soldBy")}</span>
              <span className="block truncate text-sm font-semibold text-fg">{product.seller.name}</span>
            </span>
            <span className="text-sm text-brand">{t("visitStore")}</span>
            <ChevronRight className="h-4 w-4 text-subtle" aria-hidden />
          </Link>
        </Card>
      ) : null}
    </div>
  );
}
