"use client";
import { Link } from "@/lib/i18n/navigation";
import { Clapperboard, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

export type FeedMovieRef = { slug: string; title: string; episode: number; episodeCount: number };

/** Insigna „Swypik Movies · Ep. n/total" peste un episod gratuit din feed, cu CTA spre player. */
export default function MovieEpisodeBadge({ movie }: { movie: FeedMovieRef }) {
  const t = useTranslations("movies");
  return (
    <Link
      href={`/movies/${movie.slug}/${movie.episode}`}
      className="pointer-events-auto absolute left-4 z-20 flex items-center gap-2 rounded-2xl bg-black/60 px-3 py-2 text-white ring-1 ring-white/15 backdrop-blur active:scale-95"
      style={{ top: "max(64px, calc(52px + env(safe-area-inset-top)))" }}
    >
      <Clapperboard size={16} className="text-red-400" />
      <span className="text-[11px] font-black leading-tight">
        {t("title")}
        <br />
        <span className="font-semibold text-white/70">
          {movie.title} · {t("episodeOf", { n: movie.episode, total: movie.episodeCount })}
        </span>
      </span>
      <ChevronRight size={14} />
    </Link>
  );
}
