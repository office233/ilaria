"use client";
import { useCallback, useEffect, useState } from "react";
import { Clapperboard } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import HeroTrailer from "@/components/movies/HeroTrailer";
import PosterCard from "@/components/movies/PosterCard";
import GenreChips from "@/components/movies/GenreChips";
import HomeRows from "@/components/movies/HomeRows";
import MoviesBrand from "@/components/movies/MoviesBrand";
import type { HomeRow } from "@/lib/movies/home";
import type { MovieGenre } from "@/lib/movies/genres";
import type { SeriesDto } from "@/lib/movies/types";

type Home = { featured: SeriesDto | null; rows: HomeRow[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function HomeSkeleton() {
  return (
    <div className="space-y-4 px-gutter pt-4" aria-hidden>
      <Skeleton className="h-[40dvh] w-full rounded-card" />
      <Skeleton className="h-5 w-40" />
      <div className="flex gap-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-[2/3] w-[40vw] max-w-[170px] rounded-card" />)}
      </div>
    </div>
  );
}

/** Catalogul gol e spus onest: „în pregătire", cu drumul spre creatori — fără rânduri false. */
function CatalogInPreparation() {
  const t = useTranslations("movies");
  return (
    <EmptyState
      icon={Clapperboard}
      title={t("catalogInPreparation")}
      description={t("catalogInPreparationBody")}
      action={
        <Button asChild variant="secondary">
          <Link href="/creator/movies">{t("becomeSeriesCreator")}</Link>
        </Button>
      }
      className="py-20"
    />
  );
}

export default function MoviesClient() {
  const t = useTranslations("movies");
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState(false);
  const [genre, setGenre] = useState<MovieGenre | null>(null);
  const [genreItems, setGenreItems] = useState<SeriesDto[] | null>(null);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(false);
    getJson<Home>("/api/movies/home").then(setHome).catch(() => setError(true));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    setGenreItems(null);
    if (!genre) return;
    getJson<{ items: SeriesDto[] }>(`/api/movies?genre=${genre}&sort=trending`).then((d) => setGenreItems(d.items)).catch(() => setGenreItems([]));
  }, [genre]);

  const featured = home?.featured ?? null;
  useEffect(() => {
    if (!featured) return;
    // Episodul 1 e de regulă gratuit ⇒ îl folosim ca trailer (fără sunet).
    getJson<{ playbackUrl: string }>(`/api/movies/${featured.slug}/episodes/1/play`).then((d) => setHeroUrl(d.playbackUrl)).catch(() => setHeroUrl(null));
  }, [featured]);

  const catalogEmpty = home !== null && !featured && home.rows.length === 0;

  return (
    <ImmersiveSurface>
      <PageHeader title={<MoviesBrand size="sm" />}>{!catalogEmpty && <GenreChips selected={genre} onSelect={setGenre} />}</PageHeader>
      {error ? (
        <ErrorState onRetry={load} className="py-20" />
      ) : !home ? (
        <HomeSkeleton />
      ) : catalogEmpty ? (
        <CatalogInPreparation />
      ) : genre ? (
        <section className="mx-auto max-w-5xl px-gutter pb-8 pt-4">
          {genreItems === null ? (
            <HomeSkeleton />
          ) : genreItems.length === 0 ? (
            <EmptyState title={t("emptyGenre")} />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {genreItems.map((s) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} />)}
            </div>
          )}
        </section>
      ) : (
        <div className="pb-8">
          {featured && <HeroTrailer series={featured} playbackUrl={heroUrl} />}
          <HomeRows rows={home.rows} />
        </div>
      )}
    </ImmersiveSurface>
  );
}
