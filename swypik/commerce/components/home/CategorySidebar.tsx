"use client";

/**
 * CategorySidebar — filtrul de categorii al feed-ului de oferte (Discover).
 *
 * Navigarea între module NU mai stă aici: meniul aplicației e unic, app-wide
 * (components/nav/AppMenu, din lib/nav/modules.ts). Rândul „Toate modulele”
 * deschide acel meniu.
 */
import {
  Baby,
  BookOpen,
  Car,
  Dumbbell,
  Home,
  LayoutGrid,
  PawPrint,
  Shirt,
  Smartphone,
  Sparkles,
  Tag,
  Watch,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { haptic } from "@/lib/haptic";
import { Sheet } from "@/components/ui/Sheet";
import { ListItem } from "@/components/ui/ListItem";
import { useAppMenu } from "@/components/nav/AppMenuProvider";

export type CategoryNode = {
  id?: string | number;
  name: string;
  tag?: string;
  slug?: string;
  children?: CategoryNode[];
};

type Props = {
  categories: CategoryNode[];
  /** Slug-ul taxonomiei active (id-ul nodului). */
  activeCategory: string | null;
  onSelectCategory: (slug: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function nodeSlug(c: CategoryNode): string {
  return String(c.tag ?? c.slug ?? c.id ?? c.name);
}

/** Iconiță după numele categoriei marketplace. */
function categoryIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/(elect|tech|phone|laptop)/.test(n)) return Smartphone;
  if (/(fashion|moda|imbrac|haine)/.test(n)) return Shirt;
  if (/(home|casa|garden|gradin)/.test(n)) return Home;
  if (/(beauty|frumus|cosmet)/.test(n)) return Sparkles;
  if (/(sport|fitness)/.test(n)) return Dumbbell;
  if (/(kid|copii|toy|jucar)/.test(n)) return Baby;
  if (/(auto|car|masin)/.test(n)) return Car;
  if (/(pet|animal)/.test(n)) return PawPrint;
  if (/(book|carte|carti)/.test(n)) return BookOpen;
  if (/(jewel|bijut|watch|ceas)/.test(n)) return Watch;
  return Tag;
}

export default function CategorySidebar({ categories, activeCategory, onSelectCategory, open, onOpenChange }: Props) {
  const t = useTranslations("homeFeed");
  const tMenu = useTranslations("appMenu");
  const appMenu = useAppMenu();

  const pick = (slug: string | null) => {
    haptic("tap");
    onOpenChange(false);
    onSelectCategory(slug);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="left" title={t("allCategories")} bodyClassName="px-2">
      <div className="space-y-0.5">
        <ListItem icon={LayoutGrid} title={t("all")} active={activeCategory === null} onClick={() => pick(null)} />
        {categories.map((c) => {
          const slug = nodeSlug(c);
          const active = activeCategory === slug;
          return (
            <ListItem
              key={String(c.id ?? c.name)}
              icon={categoryIcon(c.name)}
              title={c.name}
              active={active}
              onClick={() => pick(active ? null : slug)}
            />
          );
        })}
      </div>
      {appMenu ? (
        <div className="mt-4 border-t border-subtle pt-3">
          <ListItem
            icon={LayoutGrid}
            title={tMenu("allModules")}
            onClick={() => {
              onOpenChange(false);
              appMenu.setOpen(true);
            }}
          />
        </div>
      ) : null}
    </Sheet>
  );
}
