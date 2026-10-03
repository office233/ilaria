"use client";

import { useState, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { Maximize2, Music2, Pause, Play, SkipForward, X } from "lucide-react";
import { usePathname } from "@/lib/i18n/navigation";
import { haptic } from "@/lib/haptic";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import FullScreenPlayer from "./FullScreenPlayer";
import { useMusicPlayer } from "./MusicPlayerProvider";

const MINI_PLAYER_HIDDEN_PREFIXES = ["/go", "/checkout", "/kids"];
const MOVIES_PLAYER_PATH = /^\/movies\/[^/]+\/\d+/;
const SEEK_STEP_MS = 5_000;

/**
 * Mini-player persistent. Mereu închis la culoare (`data-theme="dark"` local,
 * fără a comuta restul paginii), așezat deasupra BottomNav prin
 * `--bottom-inset` (care e doar safe-area când BottomNav lipsește).
 */
export default function MiniPlayer() {
  const t = useTranslations("music");
  const pathname = usePathname();
  const { current, playing, positionMs, durationMs, toggle, next, seek, close, streamError } = useMusicPlayer();
  const [showFullScreen, setShowFullScreen] = useState(false);

  if (!current) return null;
  if (MINI_PLAYER_HIDDEN_PREFIXES.some((p) => pathname.startsWith(p)) || MOVIES_PLAYER_PATH.test(pathname)) return null;

  const pct = durationMs > 0 ? Math.min(100, Math.max(0, (positionMs / durationMs) * 100)) : 0;
  const open = () => { haptic("tap"); setShowFullScreen(true); };
  const handleSeek = (event: MouseEvent<HTMLDivElement>) => {
    if (durationMs <= 0 || current.isLive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * durationMs);
  };

  return (
    <>
      <div
        data-theme="dark"
        className="fixed inset-x-2 z-nav overflow-hidden rounded-card border border-subtle bg-elevated/95 text-fg shadow-elev-3 backdrop-blur-xl sm:left-auto sm:right-4 sm:w-[420px]"
        style={{ bottom: "calc(var(--bottom-inset) + 0.5rem)" }}
      >
        <div
          role="slider"
          aria-label={t("nowPlaying")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          tabIndex={0}
          onClick={handleSeek}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") seek(Math.min(durationMs, positionMs + SEEK_STEP_MS));
            if (event.key === "ArrowLeft") seek(Math.max(0, positionMs - SEEK_STEP_MS));
          }}
          className="h-1 w-full cursor-pointer bg-fg/10"
        >
          <div className="h-full bg-brand transition-[width] duration-fast" style={{ width: current.isLive ? "100%" : `${pct}%` }} />
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <button type="button" onClick={open} aria-label={t("audio.expand")} className="relative h-11 w-11 shrink-0 overflow-hidden rounded-control bg-surface-2">
            {current.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.coverUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            ) : (
              <Music2 className="m-auto h-5 w-5 text-subtle" aria-hidden />
            )}
          </button>
          <button type="button" onClick={open} className="min-h-11 min-w-0 flex-1 text-left">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{current.title}</span>
              {current.isLive && <Badge size="sm" tone="danger">{t("audio.liveBadge")}</Badge>}
            </span>
            {streamError ? (
              <span role="status" className="block truncate text-xs font-semibold text-danger">{t("player.streamUnavailable")}</span>
            ) : (
              <span className="block truncate text-xs text-muted">{current.artist.stageName}</span>
            )}
          </button>
          <IconButton variant="primary" label={playing ? t("pause") : t("play")} onClick={() => { haptic("tap"); toggle(); }}>
            {playing ? <Pause fill="currentColor" aria-hidden /> : <Play fill="currentColor" aria-hidden />}
          </IconButton>
          <IconButton size="sm" label={t("next")} onClick={() => { haptic("tap"); next(); }}>
            <SkipForward aria-hidden />
          </IconButton>
          <IconButton size="sm" label={t("audio.expand")} onClick={open} className="hidden min-[380px]:inline-flex">
            <Maximize2 aria-hidden />
          </IconButton>
          <IconButton size="sm" label={t("close")} onClick={() => { haptic("tap"); close(); }}>
            <X className="text-muted" aria-hidden />
          </IconButton>
        </div>
      </div>

      <FullScreenPlayer isOpen={showFullScreen} onClose={() => setShowFullScreen(false)} />
    </>
  );
}
