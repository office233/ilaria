"use client";
import { useTranslations } from "next-intl";
import { Heart, ListPlus, Music2, Pause, Play } from "lucide-react";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import type { TrackDto } from "@/lib/music/types";
import { haptic } from "@/lib/haptic";
import { formatDuration } from "./format";
import { useMusicPlayer } from "./MusicPlayerProvider";
import { usePreconnectStream } from "./player/preconnect";
import TrackAttribution from "./TrackAttribution";

type Props = {
  track: TrackDto;
  queue: TrackDto[];
  index: number;
  onLike?: (track: TrackDto) => void;
  onAddToPlaylist?: (track: TrackDto) => void;
};

/** Piesele din catalogul Swypik (nu surse externe) au like, playlist, reel. */
function isOwnCatalog(track: TrackDto): boolean {
  return !track.source || track.source === "swypik";
}

/**
 * Rând de listă pentru o piesă: copertă 48px, titlu/artist, durată, badge-uri
 * (premium/explicit/live) și acțiuni rapide (like, + playlist, folosește în reel).
 */
export default function TrackRow({ track, queue, index, onLike, onAddToPlaylist }: Props) {
  const t = useTranslations("music");
  const { current, playing, play, toggle } = useMusicPlayer();
  const isCurrent = current?.id === track.id;
  const own = isOwnCatalog(track);
  const warmStream = usePreconnectStream(track);

  const handlePlay = () => {
    haptic("tap");
    if (isCurrent) toggle();
    else play(queue, index);
  };

  return (
    <div className="flex min-h-14 items-center gap-3 px-gutter py-2">
      <button
        type="button"
        onClick={handlePlay}
        {...warmStream}
        aria-label={`${isCurrent && playing ? t("pause") : t("play")}: ${track.title}`}
        className="relative h-12 w-12 shrink-0 overflow-hidden rounded-control bg-surface-2"
      >
        {track.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={track.coverUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <Music2 className="m-auto h-5 w-5 text-subtle" aria-hidden />
        )}
        {isCurrent && (
          <span className="absolute inset-0 grid place-items-center bg-canvas/50 text-fg">
            {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn("truncate text-sm font-semibold", isCurrent ? "text-brand" : "text-fg")}>{track.title}</p>
          {track.explicit && <Badge size="sm">{t("explicitBadge")}</Badge>}
          {track.isPremium && <Badge size="sm" tone="brand">{t("premium")}</Badge>}
        </div>
        {own ? (
          <Link href={`/music/artist/${track.artist.slug}`} className="block truncate text-xs text-muted hover:text-fg">
            {track.artist.stageName}
          </Link>
        ) : (
          <p className="truncate text-xs text-muted">{track.artist.stageName}</p>
        )}
        <TrackAttribution track={track} />
      </div>

      {track.isLive ? (
        <Badge size="sm" tone="danger">{t("audio.liveBadge")}</Badge>
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-subtle">{formatDuration(track.durationMs)}</span>
      )}

      {own && (
        <div className="flex shrink-0 items-center">
          {onLike && (
            <IconButton size="sm" label={track.liked ? t("unlike") : t("like")} aria-pressed={track.liked} onClick={() => { haptic("tap"); onLike(track); }}>
              <Heart className={track.liked ? "fill-brand text-brand" : "text-muted"} aria-hidden />
            </IconButton>
          )}
          {onAddToPlaylist && (
            <IconButton size="sm" label={t("addToPlaylist")} onClick={() => { haptic("tap"); onAddToPlaylist(track); }}>
              <ListPlus className="text-muted" aria-hidden />
            </IconButton>
          )}
          {track.audioTrackId !== null && (
            <IconButton asChild size="sm" label={t("useInReel")}>
              <Link href={`/upload?audio=${track.audioTrackId}`}><Music2 className="text-muted" aria-hidden /></Link>
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
