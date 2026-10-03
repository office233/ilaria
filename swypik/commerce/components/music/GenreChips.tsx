"use client";
import { useTranslations } from "next-intl";
import { MUSIC_GENRES, musicGenreLabelKey, type MusicGenre } from "@/lib/music/genres";
import { haptic } from "@/lib/haptic";

type Props = { selected: MusicGenre | null; onSelect: (genre: MusicGenre | null) => void };

/** Chip-uri orizontale de genuri, cu „Toate" primul — echivalentul filtrului din Movies. */
export default function GenreChips({ selected, onSelect }: Props) {
  const t = useTranslations("music");
  const chip = (active: boolean) =>
    `shrink-0 snap-start rounded-full px-3.5 py-1.5 text-xs font-bold ring-1 transition active:scale-95 ${
      active ? "bg-white text-black ring-white" : "bg-white/5 text-white/80 ring-white/15 hover:bg-white/10"
    }`;
  return (
    <nav aria-label={t("genres")} className="flex snap-x gap-2 overflow-x-auto px-5 py-2 [scrollbar-width:none]">
      <button type="button" onClick={() => { haptic("tap"); onSelect(null); }} aria-pressed={selected === null} className={chip(selected === null)}>
        {t("all")}
      </button>
      {MUSIC_GENRES.map((g) => (
        <button key={g} type="button" onClick={() => { haptic("tap"); onSelect(g); }} aria-pressed={selected === g} className={chip(selected === g)}>
          {t(musicGenreLabelKey(g))}
        </button>
      ))}
    </nav>
  );
}
