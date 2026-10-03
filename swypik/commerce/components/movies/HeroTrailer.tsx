"use client";
import { useState } from "react";
import { Info, Play, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Badge } from "@/components/ui/Badge";
import { useHlsVideo } from "@/lib/video/useHlsVideo";
import { genreLabelKey, isMovieGenre } from "@/lib/movies/genres";
import type { SeriesDto } from "@/lib/movies/types";

/** Titlul recomandat: copertă + (opțional) episodul 1 gratuit ca trailer, fără sunet implicit. */
export default function HeroTrailer({ series, playbackUrl }: { series: SeriesDto; playbackUrl: string | null }) {
  const t = useTranslations("movies");
  const [muted, setMuted] = useState(true);
  const [imgBroken, setImgBroken] = useState(false);
  const videoRef = useHlsVideo(playbackUrl);
  const heroImage = series.coverUrl ?? series.posterUrl;
  const genres = series.genres.filter(isMovieGenre).map((g) => t(genreLabelKey(g)));

  return (
    <section className="relative h-[56dvh] w-full overflow-hidden bg-canvas">
      {heroImage && !imgBroken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={heroImage}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setImgBroken(true)}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      )}
      {playbackUrl && <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" autoPlay loop muted={muted} playsInline />}
      <div className="absolute inset-0 bg-gradient-to-t from-canvas via-canvas/40 to-transparent" />

      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-5xl px-gutter pb-5">
        {series.owner.isOfficial && <Badge tone="solid">{t("official")}</Badge>}
        <h1 className="mt-2 line-clamp-2 text-3xl font-black leading-tight text-fg">{series.title}</h1>
        {series.synopsis && <p className="mt-2 line-clamp-2 max-w-2xl text-sm text-muted">{series.synopsis}</p>}
        {genres.length > 0 && <p className="mt-1 text-xs text-subtle">{genres.join(" · ")}</p>}
        <div className="mt-4 flex items-center gap-2">
          <Button asChild size="lg">
            <Link href={`/movies/${series.slug}/1`}>
              <Play className="h-4 w-4" fill="currentColor" aria-hidden /> {t("play")}
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href={`/movies/${series.slug}`}>
              <Info className="h-4 w-4" aria-hidden /> {t("moreInfo")}
            </Link>
          </Button>
          {playbackUrl && (
            <IconButton variant="overlay" className="ml-auto" label={muted ? t("unmute") : t("mute")} onClick={() => setMuted((m) => !m)}>
              {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
            </IconButton>
          )}
        </div>
      </div>
    </section>
  );
}
