"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Music2, Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";
import { usePreconnectStream } from "@/components/music/player/preconnect";
import { haptic } from "@/lib/haptic";
import { cn } from "@/lib/ui/cn";
import type { TrackDto } from "@/lib/music/types";

type Props = { track: TrackDto; queue: TrackDto[]; index: number; rank?: number };

/** Card pătrat pentru rândurile orizontale (catalog Swypik și surse externe). */
export default function TrackCard({ track, queue, index, rank }: Props) {
  const t = useTranslations("music");
  const { current, playing, play, toggle } = useMusicPlayer();
  const [imgError, setImgError] = useState(false);
  const warmStream = usePreconnectStream(track);
  const isCurrent = current?.id === track.id;
  const isPlaying = isCurrent && playing;

  const handle = () => {
    haptic("tap");
    if (isCurrent) toggle();
    else play(queue, index);
  };

  return (
    <button
      type="button"
      onClick={handle}
      {...warmStream}
      aria-label={`${isPlaying ? t("pause") : t("play")}: ${track.title}`}
      aria-pressed={isPlaying}
      className="group w-[38vw] max-w-[150px] shrink-0 snap-start text-left"
    >
      <div className="relative aspect-square overflow-hidden rounded-card bg-surface-2 shadow-elev-1 transition-transform duration-base group-active:scale-[0.98]">
        {track.coverUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={track.coverUrl} alt="" referrerPolicy="no-referrer" onError={() => setImgError(true)} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-subtle">
            <Music2 className="h-8 w-8" aria-hidden />
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1">
          {rank !== undefined && <Badge tone="overlay">{rank}</Badge>}
          {track.isLive && <Badge tone="danger">{t("audio.liveBadge")}</Badge>}
          {track.isPremium && <Badge tone="solid">{t("premium")}</Badge>}
        </div>
        <span
          className={cn(
            "absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-brand text-brand-fg shadow-elev-2",
            !isPlaying && "opacity-90",
          )}
          aria-hidden
        >
          {isPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}
        </span>
      </div>
      <p className={cn("mt-2 truncate text-sm font-semibold", isCurrent ? "text-brand" : "text-fg")}>{track.title}</p>
      <p className="truncate text-xs text-muted">{track.artist.stageName}</p>
    </button>
  );
}
