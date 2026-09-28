"use client";

import type { MouseEvent } from "react";
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/ui/cn";
import { haptic } from "@/lib/haptic";
import { formatDuration } from "./format";
import { useMusicPlayer } from "./MusicPlayerProvider";

/** Bara de progres + comenzile + volumul playerului pe ecran complet. */
export default function PlayerControls() {
  const t = useTranslations("music");
  const { current, playing, positionMs, durationMs, toggle, next, prev, seek, shuffle, toggleShuffle, repeat, cycleRepeat, volume, muted, setVolume, setMuted } = useMusicPlayer();
  if (!current) return null;

  const pct = durationMs > 0 ? Math.min(100, Math.max(0, (positionMs / durationMs) * 100)) : 0;
  const handleSeek = (event: MouseEvent<HTMLDivElement>) => {
    if (durationMs <= 0 || current.isLive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * durationMs);
  };
  const repeatLabel = repeat === "one" ? t("audio.repeatOne") : repeat === "all" ? t("audio.repeatAll") : t("audio.repeatOff");
  const tap = (fn: () => void) => () => { haptic("tap"); fn(); };

  return (
    <div className="space-y-4">
      {current.isLive ? (
        <div className="flex items-center justify-between py-2">
          <Badge tone="danger">{t("audio.liveStreamRadio")}</Badge>
          <span className="text-xs text-muted">{t("audio.direct")}</span>
        </div>
      ) : (
        <div>
          <div
            role="slider"
            aria-label={t("nowPlaying")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            tabIndex={0}
            onClick={handleSeek}
            className="flex h-6 w-full cursor-pointer items-center"
          >
            <div className="h-1.5 w-full rounded-full bg-fg/15">
              <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="flex items-center justify-between text-xs tabular-nums text-muted">
            <span>{formatDuration(positionMs)}</span>
            <span>{formatDuration(durationMs)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        {!current.isLive ? (
          <IconButton label={t("shuffle")} aria-pressed={shuffle} onClick={tap(toggleShuffle)}>
            <Shuffle className={cn(shuffle ? "text-brand" : "text-muted")} aria-hidden />
          </IconButton>
        ) : <span className="h-11 w-11" aria-hidden />}
        <IconButton size="lg" label={t("previous")} onClick={tap(prev)}><SkipBack aria-hidden /></IconButton>
        <IconButton size="lg" variant="primary" label={playing ? t("pause") : t("play")} onClick={tap(toggle)} className="h-16 w-16">
          {playing ? <Pause fill="currentColor" aria-hidden /> : <Play fill="currentColor" aria-hidden />}
        </IconButton>
        <IconButton size="lg" label={t("next")} onClick={tap(next)}><SkipForward aria-hidden /></IconButton>
        {!current.isLive ? (
          <IconButton label={repeatLabel} onClick={tap(cycleRepeat)}>
            {repeat === "one" ? <Repeat1 className="text-brand" aria-hidden /> : <Repeat className={cn(repeat !== "off" ? "text-brand" : "text-muted")} aria-hidden />}
          </IconButton>
        ) : <span className="h-11 w-11" aria-hidden />}
      </div>

      <div className="flex items-center gap-2 text-muted">
        <IconButton size="sm" label={t("audio.mute")} aria-pressed={muted} onClick={() => setMuted(!muted)}>
          {muted || volume === 0 ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </IconButton>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          aria-label={t("audio.volume")}
          value={muted ? 0 : volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="h-6 flex-1 cursor-pointer accent-brand"
        />
      </div>
    </div>
  );
}
