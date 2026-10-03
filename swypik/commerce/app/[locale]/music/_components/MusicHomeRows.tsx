"use client";

/**
 * Rândurile catalogului Swypik Music (din /api/music/home). Rândurile goale
 * nu ajung aici (lib/music/home.ts); fără date externe reetichetate.
 */
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { musicGenreLabelKey } from "@/lib/music/genres";
import type { MusicHomeRow, PlaylistSummary } from "@/lib/music/home";
import TrackCard from "./TrackCard";

export function Row({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-end justify-between gap-3 px-gutter">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-fg">{title}</h2>
          {subtitle && <p className="line-clamp-1 text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-gutter pb-2 [scrollbar-width:none]">{children}</div>
    </section>
  );
}

function PlaylistChip({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <Link
      href={`/music/playlist/${playlist.id}`}
      className="flex min-h-24 w-[38vw] max-w-[160px] shrink-0 snap-start flex-col justify-end rounded-card bg-brand-soft p-3"
    >
      <p className="truncate text-sm font-semibold text-brand-soft-fg">{playlist.title}</p>
      <p className="text-xs text-muted">{playlist.trackCount}</p>
    </Link>
  );
}

export default function MusicHomeRows({ rows }: { rows: MusicHomeRow[] }) {
  const t = useTranslations("music");
  return (
    <>
      {rows.map((row) => {
        switch (row.kind) {
          case "top10":
            return <Row key="top10" title={t("audio.rowTop10")}>{row.items.map((tr, i) => <TrackCard key={tr.id} track={tr} queue={row.items} index={i} rank={i + 1} />)}</Row>;
          case "originals":
            return <Row key="originals" title={t("audio.rowOriginals")}>{row.items.map((tr, i) => <TrackCard key={tr.id} track={tr} queue={row.items} index={i} />)}</Row>;
          case "latest":
            return <Row key="latest" title={t("audio.rowLatest")}>{row.items.map((tr, i) => <TrackCard key={tr.id} track={tr} queue={row.items} index={i} />)}</Row>;
          case "liked":
            return <Row key="liked" title={t("liked")}>{row.items.map((tr, i) => <TrackCard key={tr.id} track={tr} queue={row.items} index={i} />)}</Row>;
          case "genre":
            return <Row key={`genre-${row.genre}`} title={t(musicGenreLabelKey(row.genre))}>{row.items.map((tr, i) => <TrackCard key={tr.id} track={tr} queue={row.items} index={i} />)}</Row>;
          case "playlists":
            return <Row key="playlists" title={t("playlists")}>{row.items.map((pl) => <PlaylistChip key={pl.id} playlist={pl} />)}</Row>;
        }
      })}
    </>
  );
}
