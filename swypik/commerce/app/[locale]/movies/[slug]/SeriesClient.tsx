"use client";
import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Check, Film, Play, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import UnlockButton from "@/components/movies/UnlockButton";
import Attribution from "@/components/movies/Attribution";
import { genreLabelKey, isMovieGenre } from "@/lib/movies/genres";
import type { EpisodeDto, SeriesDto } from "@/lib/movies/types";
import EpisodeList from "./_components/EpisodeList";

type Payload = {
  series: SeriesDto;
  episodes: EpisodeDto[];
  viewer: { isAuthed: boolean; hasSeasonUnlock: boolean; isOwner: boolean; inWatchlist: boolean };
};
type LoadState = { kind: "loading" } | { kind: "ok"; data: Payload } | { kind: "missing" } | { kind: "error" };

export default function SeriesClient({ slug }: { slug: string }) {
  const t = useTranslations("movies");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [listBusy, setListBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/movies/${slug}`)
      .then(async (r) => {
        if (r.status === 404) return setState({ kind: "missing" });
        if (!r.ok) throw new Error(String(r.status));
        setState({ kind: "ok", data: await r.json() });
      })
      .catch(() => setState({ kind: "error" }));
  }, [slug]);
  useEffect(load, [load]);

  const data = state.kind === "ok" ? state.data : null;
  const toggleList = async () => {
    if (!data) return;
    if (!data.viewer.isAuthed) { window.location.assign(`/auth?next=/movies/${slug}`); return; }
    setListBusy(true);
    try {
      const res = await fetch(`/api/movies/${slug}/watchlist`, { method: data.viewer.inWatchlist ? "DELETE" : "POST" });
      if (res.ok) {
        const d = await res.json();
        setState({ kind: "ok", data: { ...data, viewer: { ...data.viewer, inWatchlist: Boolean(d.inWatchlist) } } });
      }
    } finally {
      setListBusy(false);
    }
  };

  return (
    <ImmersiveSurface>
      <PageHeader back="/movies" tone="transparent" className="absolute inset-x-0" />
      {state.kind === "loading" && (
        <div className="space-y-4 pb-8" aria-hidden>
          <Skeleton className="h-[50dvh] w-full rounded-none" />
          <SkeletonText className="px-gutter" />
        </div>
      )}
      {state.kind === "error" && <ErrorState onRetry={load} className="pt-24" />}
      {state.kind === "missing" && <EmptyState icon={Film} title={t("titleNotFound")} className="pt-24" />}
      {data && <SeriesBody slug={slug} data={data} listBusy={listBusy} onToggleList={toggleList} onUnlocked={load} />}
    </ImmersiveSurface>
  );
}

function SeriesBody({ slug, data, listBusy, onToggleList, onUnlocked }: { slug: string; data: Payload; listBusy: boolean; onToggleList: () => void; onUnlocked: () => void }) {
  const t = useTranslations("movies");
  const { series, episodes, viewer } = data;
  const inProgress = episodes.find((e) => e.progress && !e.progress.completed);
  const resume = inProgress ?? episodes.find((e) => !e.progress?.completed) ?? episodes[0];
  const lockedCount = episodes.filter((e) => e.locked).length;
  const canBuySeason = lockedCount > 0 && !viewer.hasSeasonUnlock && !viewer.isOwner && series.seasonPriceCents !== null && series.seasonPriceCents > 0;
  const genres = series.genres.filter(isMovieGenre).map((g) => t(genreLabelKey(g)));

  return (
    <div className="pb-8">
      <section className="relative h-[55dvh]">
        {series.posterUrl && <Image src={series.posterUrl} alt="" fill priority sizes="100vw" className="object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-canvas via-canvas/50 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 mx-auto max-w-5xl px-gutter pb-4">
          {series.owner.isOfficial ? <Badge tone="solid">{t("official")}</Badge> : <p className="text-xs text-muted">{t("by", { name: series.owner.name })}</p>}
          <h1 className="mt-1 text-3xl font-black leading-tight text-fg">{series.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {series.format === "series" && <span className="text-xs text-muted">{t("episodes", { count: series.episodeCount })}</span>}
            {series.format === "series" && series.freeEpisodes > 0 && <Badge tone="success">{t("freeBadge", { n: series.freeEpisodes })}</Badge>}
            {series.isAdult && <Badge tone="danger">{t("adult")}</Badge>}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl space-y-3 px-gutter pt-2">
        <div className="flex gap-2">
          {resume && (
            <Button asChild size="lg" className="flex-1">
              <Link href={`/movies/${slug}/${resume.number}`}>
                <Play className="h-4 w-4" fill="currentColor" aria-hidden /> {inProgress ? t("resume") : t("play")}
              </Link>
            </Button>
          )}
          <Button size="lg" variant="secondary" onClick={onToggleList} loading={listBusy} aria-pressed={viewer.inWatchlist}>
            {!listBusy && (viewer.inWatchlist ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />)}
            {viewer.inWatchlist ? t("inList") : t("myList")}
          </Button>
        </div>
        {canBuySeason && (
          <div className="rounded-card bg-surface-2 p-3">
            <UnlockButton slug={slug} target={{ season: true }} priceCents={series.seasonPriceCents} label={t("unlockSeason")} onUnlocked={onUnlocked} />
            <p className="mt-1 text-center text-xs text-muted">{t("seasonDiscount", { pct: series.seasonDiscountPct })}</p>
          </div>
        )}
        {series.synopsis && <p className="text-sm leading-relaxed text-fg">{series.synopsis}</p>}
        {genres.length > 0 && <p className="text-xs text-muted">{t("genres")}: {genres.join(", ")}</p>}
        {series.attribution && <Attribution attribution={series.attribution} />}
      </section>

      {(series.format === "series" || episodes.length > 1) && <EpisodeList slug={slug} series={series} episodes={episodes} />}
    </div>
  );
}
