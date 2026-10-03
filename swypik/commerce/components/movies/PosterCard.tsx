"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/Badge";
import { genreLabelKey, isMovieGenre } from "@/lib/movies/genres";
import type { SeriesDto } from "@/lib/movies/types";

const PROGRESS_MIN_VISIBLE_PCT = 2;

type Props = { series: SeriesDto; href: string; progressPct?: number; rank?: number };

/** Poster 2:3 pentru rândurile orizontale și grilele de gen. */
export default function PosterCard({ series, href, progressPct, rank }: Props) {
  const t = useTranslations("movies");
  const [broken, setBroken] = useState(false);
  const showImage = Boolean(series.posterUrl) && !broken;
  const genres = series.genres.slice(0, 2).map((g) => (isMovieGenre(g) ? t(genreLabelKey(g)) : g));

  return (
    <Link href={href} className="group block w-[40vw] max-w-[170px] shrink-0 snap-start">
      <div className="relative aspect-[2/3] overflow-hidden rounded-card bg-surface-2 shadow-elev-1 transition-transform duration-base group-active:scale-[0.98]">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={series.posterUrl ?? undefined}
            alt={series.title}
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-3 text-center text-sm font-semibold text-muted">{series.title}</div>
        )}
        <div className="absolute left-2 top-2 flex gap-1">
          {rank !== undefined && <Badge tone="solid">#{rank}</Badge>}
          {series.isAdult && <Badge tone="danger">18+</Badge>}
        </div>
        {progressPct !== undefined && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-fg/20">
            <div className="h-full bg-brand" style={{ width: `${Math.min(100, Math.max(PROGRESS_MIN_VISIBLE_PCT, progressPct))}%` }} />
          </div>
        )}
      </div>
      <p className="mt-2 line-clamp-1 text-sm font-semibold text-fg">{series.title}</p>
      {genres.length > 0 && <p className="line-clamp-1 text-xs text-muted">{genres.join(" · ")}</p>}
    </Link>
  );
}
