"use client";

import { useTranslations } from "next-intl";
import type { CatalogCard } from "@/lib/shop/catalog";
import { ProductCard } from "../ProductCard";

/** Carusel orizontal de produse similare (legături interne, bune și pentru SEO). */
export function SimilarProducts({ products }: { products: CatalogCard[] }) {
  const t = useTranslations("shopBuyer.product");
  if (products.length === 0) return null;
  return (
    <section aria-labelledby="similar-heading" className="space-y-3">
      <h2 id="similar-heading" className="text-base font-semibold text-fg">
        {t("similar")}
      </h2>
      <ul className="no-scrollbar -mx-gutter flex gap-3 overflow-x-auto px-gutter pb-1">
        {products.map((p) => (
          <li key={p.id} className="w-40 shrink-0">
            <ProductCard product={p} sizes="160px" />
          </li>
        ))}
      </ul>
    </section>
  );
}
