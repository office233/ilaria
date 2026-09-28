"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Volume2, VolumeX } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { getPathname, Link } from "@/lib/i18n/navigation";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import PaywallSlide from "@/components/movies/PaywallSlide";
import type { EpisodeDto, SeriesDto } from "@/lib/movies/types";
import EpisodeVideo from "./EpisodeVideo";

type SeriesPayload = { series: SeriesDto; episodes: EpisodeDto[]; viewer: { isAuthed: boolean } };
type PlayOk = { playbackUrl: string; poster: string | null };
type PlayLocked = { error: "locked"; priceCents: number | null; seasonPriceCents: number | null; requireAuth: boolean };
type PlayState = { kind: "loading" } | { kind: "ok"; data: PlayOk } | { kind: "locked"; data: PlayLocked } | { kind: "error" };

const PROGRESS_INTERVAL_MS = 5000;
const SWIPE_THRESHOLD_PX = 80;
const PROGRESS_DOTS_MAX = 40;
/** O eroare de redare (token expirat etc.) reîncarcă sursa, dar nu la infinit. */
const MAX_PLAY_RELOADS = 2;

export default function PlayerClient({ slug, initialEpisode }: { slug: string; initialEpisode: number }) {
  const t = useTranslations("movies");
  const locale = useLocale();
  const [payload, setPayload] = useState<SeriesPayload | null>(null);
  const [current, setCurrent] = useState(initialEpisode);
  const [play, setPlay] = useState<PlayState>({ kind: "loading" });
  const [muted, setMuted] = useState(false);
  const lastSentRef = useRef(0);
  const reloadsRef = useRef(0);

  const loadSeries = useCallback(
    () => fetch(`/api/movies/${slug}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then(setPayload).catch(() => setPlay({ kind: "error" })),
    [slug],
  );
  useEffect(() => { void loadSeries(); }, [loadSeries]);

  const loadPlay = useCallback(async (n: number) => {
    setPlay({ kind: "loading" });
    const res = await fetch(`/api/movies/${slug}/episodes/${n}/play`, { cache: "no-store" }).catch(() => null);
    if (!res) { setPlay({ kind: "error" }); return; }
    const data = await res.json().catch(() => null);
    if (res.ok && data) setPlay({ kind: "ok", data });
    else if (res.status === 402 && data) setPlay({ kind: "locked", data });
    else setPlay({ kind: "error" });
  }, [slug]);
  useEffect(() => {
    reloadsRef.current = 0;
    void loadPlay(current);
    // URL-ul păstrează prefixul de limbă (altfel un refresh cădea pe limba implicită).
    window.history.replaceState(null, "", getPathname({ href: `/movies/${slug}/${current}`, locale }));
  }, [current, loadPlay, slug, locale]);

  const episodes = payload?.episodes ?? [];
  const index = episodes.findIndex((e) => e.number === current);
  const episode = index >= 0 ? episodes[index] : null;
  const total = episodes.length;
  // Navigare după poziție, nu după număr+1: găurile în numerotare nu mai dau ecran gol.
  const nextNumber = index >= 0 && index < total - 1 ? episodes[index + 1].number : null;
  const prevNumber = index > 0 ? episodes[index - 1].number : null;

  const sendProgress = useCallback((positionMs: number, completed: boolean) => {
    if (!episode || !payload?.viewer?.isAuthed) return; // anonimii nu au progres
    const body = JSON.stringify({ episodeId: episode.id, positionMs: Math.round(positionMs), completed });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/movies/progress", new Blob([body], { type: "application/json" }));
    else void fetch("/api/movies/progress", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  }, [episode, payload]);

  const onTime = useCallback((ms: number) => {
    const now = Date.now();
    if (now - lastSentRef.current > PROGRESS_INTERVAL_MS) {
      lastSentRef.current = now;
      sendProgress(ms, false);
    }
  }, [sendProgress]);

  const goNext = useCallback(() => {
    sendProgress(episode?.durationMs ?? 0, true);
    if (nextNumber !== null) setCurrent(nextNumber);
  }, [nextNumber, episode, sendProgress]);

  const onVideoError = useCallback(() => {
    if (reloadsRef.current >= MAX_PLAY_RELOADS) { setPlay({ kind: "error" }); return; }
    reloadsRef.current += 1;
    void loadPlay(current);
  }, [current, loadPlay]);

  // Swipe vertical: sus = următorul, jos = anteriorul.
  const touchStart = useRef<number | null>(null);
  // Pe paywall (formular de plată) swipe-ul NU schimbă episodul.
  const onTouchStart = (e: React.TouchEvent) => { touchStart.current = play.kind === "locked" ? null : e.touches[0].clientY; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStart.current === null) return;
    const dy = e.changedTouches[0].clientY - touchStart.current;
    touchStart.current = null;
    if (dy < -SWIPE_THRESHOLD_PX && nextNumber !== null) setCurrent(nextNumber);
    if (dy > SWIPE_THRESHOLD_PX && prevNumber !== null) setCurrent(prevNumber);
  };

  return (
    <ImmersiveSurface fullscreen>
      <div className="fixed inset-0 bg-canvas" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {play.kind === "loading" && <Skeleton className="h-full w-full rounded-none" />}
        {play.kind === "ok" && episode && (
          <EpisodeVideo
            src={play.data.playbackUrl}
            poster={play.data.poster}
            muted={muted}
            onEnded={goNext}
            onTime={onTime}
            onError={onVideoError}
            fit={payload?.series.format === "film" ? "contain" : "cover"}
            resumeMs={episode.progress?.completed ? 0 : episode.progress?.positionMs ?? 0}
          />
        )}
        {play.kind === "locked" && episode && payload && (
          <PaywallSlide
            slug={slug}
            episodeId={episode.id}
            episodeNumber={current}
            totalEpisodes={total}
            priceCents={play.data.priceCents}
            seasonPriceCents={play.data.seasonPriceCents}
            poster={payload.series.posterUrl}
            onUnlocked={() => { void loadSeries(); void loadPlay(current); }}
          />
        )}
        {play.kind === "error" && <ErrorState title={t("loadError")} onRetry={() => { reloadsRef.current = 0; void loadPlay(current); }} className="h-full justify-center" />}

        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 px-gutter pt-safe-t">
          <IconButton asChild variant="overlay" label={t("back")} className="pointer-events-auto mt-2">
            <Link href={`/movies/${slug}`}><ArrowLeft aria-hidden /></Link>
          </IconButton>
          <div className="mt-2 flex flex-1 gap-1" aria-hidden>
            {payload?.episodes.slice(0, PROGRESS_DOTS_MAX).map((e) => (
              <span key={e.id} className={e.number < current ? "h-0.5 flex-1 rounded bg-fg" : e.number === current ? "h-0.5 flex-1 rounded bg-brand" : "h-0.5 flex-1 rounded bg-fg/25"} />
            ))}
          </div>
          <IconButton variant="overlay" label={muted ? t("unmute") : t("mute")} onClick={() => setMuted((m) => !m)} className="pointer-events-auto mt-2">
            {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
          </IconButton>
        </div>

        {payload && episode && play.kind === "ok" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-canvas/90 to-transparent px-gutter pb-safe-b pt-16">
            {/* Deasupra barei de controale native (pauză/derulare), care rămâne clicabilă. */}
            <div className="pointer-events-auto mb-16">
              <p className="text-sm text-muted">{payload.series.title}</p>
              <h2 className="text-lg font-bold text-fg">{t("episodeOf", { n: index + 1, total })} · {episode.title}</h2>
              {nextNumber !== null && (
                <Button variant="secondary" size="sm" className="mt-3" onClick={goNext}>
                  {t("nextEpisode")} <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </ImmersiveSurface>
  );
}
