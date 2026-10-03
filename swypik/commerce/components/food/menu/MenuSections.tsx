"use client";

/** Meniul pe categorii: bară de categorii (sări la secțiune) + articole. */
import Image from "next/image";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { haptic } from "@/lib/haptic";
import type { MenuItem, MenuSection } from "@/lib/food/types";

type Props = { sections: MenuSection[]; canOrder: boolean; onPick: (item: MenuItem) => void };

const sectionId = (s: MenuSection) => `menu-${s.id ?? "other"}`;

export default function MenuSections({ sections, canOrder, onPick }: Props) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const label = (s: MenuSection) => s.name ?? t("otherCategory");

  return (
    <div>
      {sections.length > 1 ? (
        <nav
          aria-label={t("categoriesLabel")}
          className="sticky top-[calc(var(--header-h,56px)+env(safe-area-inset-top))] z-10 -mx-gutter flex gap-2 overflow-x-auto bg-canvas/95 px-gutter py-2 backdrop-blur scrollbar-none"
        >
          {sections.map((s) => (
            <a
              key={sectionId(s)}
              href={`#${sectionId(s)}`}
              className="inline-flex h-11 shrink-0 items-center rounded-full bg-surface-2 px-4 text-sm font-semibold text-muted"
            >
              {label(s)}
            </a>
          ))}
        </nav>
      ) : null}

      {sections.map((s) => (
        <section key={sectionId(s)} id={sectionId(s)} className="mt-4 scroll-mt-32">
          <h3 className="mb-2 text-base font-bold text-fg">{label(s)}</h3>
          <ul className="space-y-2">
            {s.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!canOrder}
                  onClick={() => {
                    haptic("tap");
                    onPick(item);
                  }}
                  className="flex w-full gap-3 rounded-card border border-subtle bg-surface p-3 text-left transition active:scale-[0.99] disabled:opacity-60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold leading-snug text-fg">{item.name}</p>
                    {item.description ? <p className="mt-0.5 line-clamp-2 text-sm text-muted">{item.description}</p> : null}
                    <p className="mt-1.5 text-sm font-bold text-fg">{fmt(item.price_cents)}</p>
                  </div>
                  {item.image_url ? (
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-control bg-surface-2">
                      <Image src={item.image_url} alt="" fill sizes="80px" className="object-cover" />
                    </div>
                  ) : canOrder ? (
                    <span className="grid h-11 w-11 shrink-0 place-items-center self-center rounded-full bg-brand text-brand-fg" aria-hidden>
                      <Plus size={18} />
                    </span>
                  ) : null}
                  {canOrder ? <span className="sr-only">{t("addToCart")}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
