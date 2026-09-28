"use client";

import { useEffect, useState } from "react";
import TrackAttribution from "./TrackAttribution";
import { ChevronDown, Heart, Music2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { IconButton } from "@/components/ui/IconButton";
import { Badge } from "@/components/ui/Badge";
import { haptic } from "@/lib/haptic";
import { setTrackLiked } from "@/app/[locale]/music/_lib/track-actions";
import { useMusicPlayer } from "./MusicPlayerProvider";
import PlayerControls from "./PlayerControls";

type Props = { isOpen: boolean; onClose: () => void };

/** Surse externe fără like server-side — Swypik nu are ce persista pentru ele. */
const NON_LIKEABLE_SOURCES = new Set(["radio", "audius", "jamendo", "podcast"]);

export default function FullScreenPlayer({ isOpen, onClose }: Props) {
  const t = useTranslations("music");
  const { current } = useMusicPlayer();
  const [isLiked, setIsLiked] = useState(false);
  const [likeBusy, setLikeBusy] = useState(false);

  useEffect(() => {
    if (current) setIsLiked(Boolean(current.liked));
  }, [current]);

  if (!isOpen || !current) return null;
  const canLike = !NON_LIKEABLE_SOURCES.has(current.source ?? "swypik");

  const toggleLike = async () => {
    if (!canLike || likeBusy) return;
    haptic("tap");
    const nextLiked = !isLiked;
    setIsLiked(nextLiked);
    setLikeBusy(true);
    const ok = await setTrackLiked(current.slug, nextLiked);
    setLikeBusy(false);
    if (!ok) setIsLiked(!nextLiked); // rollback — API-ul a eșuat
  };

  return (
    <ImmersiveSurface fullscreen className="fixed inset-0 z-overlay flex flex-col px-gutter pb-safe-b pt-safe-t">
      <div role="dialog" aria-modal="true" aria-label={t("nowPlaying")} className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <div className="flex h-header items-center justify-between">
          <IconButton label={t("close")} onClick={() => { haptic("tap"); onClose(); }} className="-ml-2">
            <ChevronDown aria-hidden />
          </IconButton>
          <div className="min-w-0 text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted">{current.isLive ? t("audio.radioLive") : t("title")}</p>
            <p className="max-w-[200px] truncate text-sm font-semibold">{current.artist.stageName}</p>
          </div>
          <span className="h-11 w-11" aria-hidden />
        </div>

        <div className="my-auto flex justify-center py-6">
          <div className="relative aspect-square w-[75vw] max-w-[320px] overflow-hidden rounded-sheet bg-surface-2 shadow-elev-3">
            {current.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.coverUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            ) : (
              <Music2 className="absolute inset-0 m-auto h-16 w-16 text-subtle" aria-hidden />
            )}
            {current.isLive && <Badge tone="danger" className="absolute left-3 top-3">{t("audio.liveAudio")}</Badge>}
          </div>
        </div>

        <div className="space-y-4 pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-2xl font-bold">{current.title}</h2>
              <p className="truncate text-sm text-muted">{current.artist.stageName}</p>
              <TrackAttribution track={current} className="mt-1" />
            </div>
            {canLike && (
              <IconButton label={isLiked ? t("unlike") : t("like")} aria-pressed={isLiked} disabled={likeBusy} onClick={() => void toggleLike()}>
                <Heart className={isLiked ? "fill-brand text-brand" : "text-muted"} aria-hidden />
              </IconButton>
            )}
          </div>
          <PlayerControls />
        </div>
      </div>
    </ImmersiveSurface>
  );
}
