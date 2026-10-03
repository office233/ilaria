"use client";

/**
 * Restaurant care NU e încă pe Swypik (profil nerevendicat). Afișat onest:
 * fără taxă, timp de livrare sau „Deschis” — doar numele, orașul și
 * acțiunea „Sugerează proprietarului”.
 */
import Link from "next/link";
import { Check, Megaphone, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import type { MerchantSummary } from "@/lib/food/types";
import { useCuisineLabel } from "./cuisine-ui";

type Props = {
  m: MerchantSummary;
  suggested: boolean;
  count: number;
  busy: boolean;
  onSuggest: (id: string) => void;
};

export default function UnclaimedMerchantRow({ m, suggested, count, busy, onSuggest }: Props) {
  const t = useTranslations("foodHub");
  const cuisineLabel = useCuisineLabel();
  const meta = [m.cuisines.map(cuisineLabel).filter(Boolean).slice(0, 2).join(" · "), m.city].filter(Boolean).join(" · ");

  return (
    <div className="flex items-center gap-3 rounded-card border border-subtle bg-surface p-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-control bg-surface-2 text-subtle" aria-hidden>
        <Store size={20} />
      </span>
      <Link href={`/food/${m.slug}`} className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-fg">{m.name}</p>
        <p className="truncate text-xs text-muted">{meta || t("notOnSwypik")}</p>
        {count > 0 ? <p className="text-xs text-subtle">{t("suggestCount", { count })}</p> : null}
      </Link>
      <Button
        size="sm"
        variant={suggested ? "soft" : "secondary"}
        loading={busy}
        disabled={suggested}
        onClick={() => onSuggest(m.id)}
        className="min-h-11 shrink-0"
        aria-label={t("suggestAria", { name: m.name })}
      >
        {suggested ? <Check size={16} aria-hidden /> : <Megaphone size={16} aria-hidden />}
        <span className="hidden min-[380px]:inline">{suggested ? t("suggested") : t("suggest")}</span>
      </Button>
    </div>
  );
}
