"use client";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";
import { MOVIE_GENRES, genreLabelKey, type MovieGenre } from "@/lib/movies/genres";

type Props = { selected: MovieGenre | null; onSelect: (genre: MovieGenre | null) => void };

const chip = (active: boolean) =>
  cn(
    "h-11 shrink-0 select-none whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-colors duration-fast active:scale-[0.98]",
    active ? "bg-brand text-brand-fg" : "border border-subtle bg-surface-2 text-muted hover:text-fg",
  );

/** Rândul de categorii (chip-uri) pentru Swypik Movies. */
export default function GenreChips({ selected, onSelect }: Props) {
  const t = useTranslations("movies");
  return (
    <nav aria-label={t("categories")} className="flex items-center gap-2 overflow-x-auto px-gutter pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button type="button" onClick={() => onSelect(null)} className={chip(selected === null)} aria-pressed={selected === null}>
        {t("all")}
      </button>
      {MOVIE_GENRES.map((g) => (
        <button key={g} type="button" onClick={() => onSelect(g)} className={chip(selected === g)} aria-pressed={selected === g}>
          {t(genreLabelKey(g))}
        </button>
      ))}
    </nav>
  );
}
