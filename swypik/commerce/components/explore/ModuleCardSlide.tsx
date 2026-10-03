"use client";

import Link from "next/link";
import { BedDouble, Clapperboard, ExternalLink, Music, Newspaper, Radio, ShoppingBag, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import type { FeedCard, FeedCardKind } from "@/lib/feed/types";
import { compactCount } from "./format";

const ICON: Record<FeedCardKind, LucideIcon> = {
  product: ShoppingBag,
  food: UtensilsCrossed,
  movie: Clapperboard,
  music: Music,
  stay: BedDouble,
  live: Radio,
  news: Newspaper,
};

/** Card de modul pe ecran întreg, intercalat între clipuri (slot configurabil). */
export default function ModuleCardSlide({ card }: { card: FeedCard }) {
  const t = useTranslations("explore");
  const locale = useLocale() as Locale;
  const Icon = ICON[card.kind];
  const price = card.price ? formatMoneyCents(card.price.cents, card.price.currency, locale) : null;

  return (
    <article className="relative flex h-full w-full flex-col justify-end overflow-hidden bg-canvas" aria-label={t(`card.${card.kind}`)}>
      {card.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagini din module/surse externe (copertă, știri), în afara domeniilor next/image
        <img src={card.image} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" aria-hidden />
      <div className="relative z-10 flex flex-col gap-3 px-gutter text-white" style={{ paddingBottom: "calc(var(--bottom-inset, 0px) + 1.5rem)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="overlay">
            <Icon aria-hidden className="h-3.5 w-3.5" />
            {t(`card.${card.kind}`)}
          </Badge>
          {card.kind === "live" && card.viewerCount != null ? (
            <Badge tone="danger">{t("liveViewers", { count: compactCount(card.viewerCount, locale) })}</Badge>
          ) : null}
          {card.isFree ? <Badge tone="success">{t("free")}</Badge> : null}
        </div>
        <h2 className="line-clamp-3 text-2xl font-bold leading-tight">{card.title}</h2>
        {card.subtitle ? <p className="text-sm text-white/80">{card.subtitle}</p> : null}
        {card.summary ? <p className="line-clamp-4 text-sm text-white/90">{card.summary}</p> : null}
        {price ? (
          <p className="text-lg font-bold tabular-nums">
            {card.price?.unit === "night" ? t("pricePerNight", { price }) : price}
          </p>
        ) : null}
        {card.attribution ? (
          <p className="text-xs text-white/70">
            {card.sourceUrl ? (
              <a href={card.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 underline">
                {t("via", { source: card.attribution })}
                <ExternalLink aria-hidden className="h-3 w-3" />
              </a>
            ) : (
              card.attribution
            )}
          </p>
        ) : null}
        <Button asChild size="lg" block>
          <Link href={card.href}>{t(`cardCta.${card.kind}`)}</Link>
        </Button>
      </div>
    </article>
  );
}
