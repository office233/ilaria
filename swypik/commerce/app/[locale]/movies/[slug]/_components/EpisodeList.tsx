"use client";
import Image from "next/image";
import { Check, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { EpisodeDto, SeriesDto } from "@/lib/movies/types";

const MS_PER_MINUTE = 60_000;

function EpisodeMeta({ e, series }: { e: EpisodeDto; series: SeriesDto }) {
  const t = useTranslations("movies");
  const formatPrice = useFormatPrice();
  const parts: string[] = [];
  if (e.durationMs) parts.push(t("minutes", { n: Math.max(1, Math.round(e.durationMs / MS_PER_MINUTE)) }));
  if (e.locked) parts.push(e.priceCents !== null ? formatPrice(e.priceCents, { sourceCurrency: "RON" }) : t("priceComingSoon"));
  else if (e.number <= series.freeEpisodes) parts.push(t("free"));
  return <p className="mt-0.5 text-xs text-muted">{parts.join(" · ")}</p>;
}

/** Lista episoadelor: miniatură 9:16, lacăt pentru cele blocate, progresul vizionării. */
export default function EpisodeList({ slug, series, episodes }: { slug: string; series: SeriesDto; episodes: EpisodeDto[] }) {
  const t = useTranslations("movies");
  return (
    <section className="mx-auto mt-6 max-w-5xl px-gutter">
      <h2 className="mb-3 text-base font-semibold text-fg">{t("episodesTitle")}</h2>
      <ol className="space-y-2">
        {episodes.map((e) => {
          const pct = e.progress && !e.progress.completed && e.durationMs ? Math.min(100, Math.round((e.progress.positionMs / e.durationMs) * 100)) : null;
          return (
            <li key={e.id}>
              <Link href={`/movies/${slug}/${e.number}`} className="flex min-h-11 gap-3 rounded-control p-1 active:bg-surface-2">
                <div className="relative aspect-[9/16] w-[72px] shrink-0 overflow-hidden rounded-control bg-surface-2">
                  {e.thumbnailUrl && <Image src={e.thumbnailUrl} alt="" fill sizes="72px" className={e.locked ? "object-cover opacity-50" : "object-cover"} />}
                  {e.locked && <Lock className="absolute inset-0 m-auto h-4 w-4 text-fg" aria-label={t("locked")} />}
                  {pct !== null && (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-fg/20">
                      <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <p className="text-sm font-semibold text-fg">
                    <span className="text-subtle">{e.number}.</span> {e.title}
                    {e.progress?.completed && <Check className="ml-1 inline h-4 w-4 text-success" aria-label={t("watched")} />}
                  </p>
                  <EpisodeMeta e={e} series={series} />
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
