"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Sparkles, SwitchCamera, Timer, X, Settings2, MicOff } from "lucide-react";
import { useTranslations } from "next-intl";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { createFilteredStream } from "@/lib/reels/canvas-pipeline";
import { FILTER_PRESETS, getFilter, type FilterId } from "@/lib/reels/filters";
import { useCamera } from "@/lib/reels/use-camera";
import { useRecorder } from "@/lib/reels/use-recorder";
import { cn } from "@/lib/ui/cn";
import { formatDuration } from "@/lib/upload/media";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import { RecordButton } from "./RecordButton";

const COUNTDOWNS = [0, 3, 10] as const;

/** Camera (ecran imersiv): filtre, temporizator, pauză/continuare, limită de durată. */
export function CameraCapture(props: { onCaptured: (blob: Blob) => void; onGallery: () => void; onClose: () => void }) {
  const t = useTranslations("videoUpload.camera");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pipelineRef = useRef<{ stop: () => void } | null>(null);
  const [filterId, setFilterId] = useState<FilterId>("none");
  const [countdown, setCountdown] = useState<(typeof COUNTDOWNS)[number]>(3);
  const [showFilters, setShowFilters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mirror, setMirror] = useState(true);
  const [grid, setGrid] = useState(false);
  const [microphone, setMicrophone] = useState(true);
  const camera = useCamera({ facing: "user" });
  const filterCss = useMemo(() => getFilter(filterId).css, [filterId]);

  const stopPipeline = useCallback(() => {
    pipelineRef.current?.stop();
    pipelineRef.current = null;
  }, []);

  const getRecordingStream = useCallback(
    (cam: MediaStream): MediaStream => {
      stopPipeline();
      if (filterId === "none") return cam;
      const p = createFilteredStream(cam, filterCss, 30);
      pipelineRef.current = { stop: p.stop };
      return p.outputStream;
    },
    [filterId, filterCss, stopPipeline],
  );

  const { onCaptured } = props;
  const recorder = useRecorder(camera.stream, {
    maxDurationMs: VIDEO_LIMITS.maxRecordMs,
    countdownSeconds: countdown,
    onError: stopPipeline,
    getRecordingStream,
    onComplete: (blob) => {
      stopPipeline();
      onCaptured(blob);
    },
  });

  useEffect(() => stopPipeline, [stopPipeline]);
  useEffect(() => {
    if (videoRef.current) camera.attachVideo(videoRef.current);
  }, [camera.stream, camera.attachVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    camera.stream?.getAudioTracks().forEach((track) => { track.enabled = microphone; });
  }, [camera.stream, microphone]);

  const recording = recorder.state === "recording";
  const paused = recorder.state === "paused";
  const idle = recorder.state === "idle";
  const counting = recorder.state === "countdown";
  const hasContent = recorder.elapsedMs > 0 && (recording || paused);

  const onMainButton = () => {
    if (idle) {
      setShowFilters(false);
      setShowSettings(false);
      recorder.startCountdown();
    }
    else if (recording) recorder.pause();
    else if (paused) recorder.resume();
  };

  if (camera.status === "denied" || camera.status === "unavailable") {
    return (
      <ImmersiveSurface fullscreen className="fixed inset-0 z-overlay flex flex-col items-center justify-center gap-4 px-gutter pb-safe-b pt-safe-t text-center">
        <p className="text-lg font-semibold">{camera.status === "denied" ? t("denied") : t("unavailable")}</p>
        <p className="max-w-sm text-sm text-muted">{camera.status === "denied" ? t("deniedHint") : t("unavailableHint")}</p>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Button block onClick={props.onGallery}>
            <ImagePlus className="h-5 w-5" aria-hidden /> {t("useGallery")}
          </Button>
          <Button block variant="ghost" onClick={props.onClose}>
            {t("close")}
          </Button>
        </div>
      </ImmersiveSurface>
    );
  }

  return (
    <ImmersiveSurface fullscreen className="fixed inset-0 z-overlay overflow-hidden bg-black">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain"
        autoPlay
        playsInline
        muted
        style={{ filter: filterCss, transform: camera.facing === "user" && mirror ? "scaleX(-1)" : "none" }}
      />
      {grid ? (
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden>
          {Array.from({ length: 9 }, (_, index) => <div key={index} className="border border-white/20" />)}
        </div>
      ) : null}
      {!microphone ? <span className="absolute left-3 top-[calc(var(--safe-top)+5rem)] rounded-full bg-overlay/60 p-2 text-fg" role="status" aria-label={t("microphoneOff")}><MicOff className="h-5 w-5" aria-hidden /></span> : null}
      {counting && recorder.countdownValue > 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-live="assertive">
          <span className="text-8xl font-black text-white drop-shadow-2xl">{recorder.countdownValue}</span>
        </div>
      ) : null}

      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 pt-safe-t">
        <IconButton variant="overlay" label={t("close")} onClick={props.onClose}>
          <X aria-hidden />
        </IconButton>
        {idle ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="bg-black/40 text-white hover:bg-black/55"
              onClick={() => setCountdown(COUNTDOWNS[(COUNTDOWNS.indexOf(countdown) + 1) % COUNTDOWNS.length])}
              aria-label={t("timer", { sec: countdown })}
            >
              <Timer className="h-5 w-5" aria-hidden /> {countdown === 0 ? t("timerOff") : `${countdown}s`}
            </Button>
            <IconButton variant="overlay" label={t("filters")} aria-pressed={showFilters} onClick={() => setShowFilters((v) => !v)}>
              <Sparkles aria-hidden />
            </IconButton>
            <IconButton variant="overlay" label={t("switchCamera")} disabled={camera.status !== "ready"} onClick={() => void camera.switchFacing()}>
              <SwitchCamera aria-hidden />
            </IconButton>
      <Dialog open={showSettings && idle} onOpenChange={(open) => { setShowFilters(false); setShowSettings(open); }} title={t("settings")} description={t("settingsHint")} trigger={
        <IconButton variant="overlay" label={t("settings")}><Settings2 aria-hidden /></IconButton>
      }>
        <div className="space-y-4">
          <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
            <span>{t("mirror")}<span className="mt-1 block text-xs text-muted">{t("mirrorHint")}</span></span>
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-current" checked={camera.facing === "user" && mirror} disabled={camera.facing !== "user"} onChange={(event) => setMirror(event.target.checked)} />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
            <span>{t("grid")}<span className="mt-1 block text-xs text-muted">{t("gridHint")}</span></span>
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-current" checked={grid} onChange={(event) => setGrid(event.target.checked)} />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
            <span>{t("microphone")}</span>
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-current" checked={microphone} disabled={!camera.stream?.getAudioTracks().length} onChange={(event) => setMicrophone(event.target.checked)} />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
            <span>{t("countdownLabel")}</span>
            <select className="min-h-11 rounded-lg border border-current bg-transparent px-3" value={countdown} onChange={(event) => setCountdown(Number(event.target.value) as (typeof COUNTDOWNS)[number])}>
              {COUNTDOWNS.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? t("timerOff") : `${seconds}s`}</option>)}
            </select>
          </label>
        </div>
      </Dialog>
          </div>
        ) : null}
      </div>


      {showFilters && idle ? (
        <div className="absolute inset-x-0 z-10 px-3" style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 9rem)" }}>
          <div className="flex snap-x gap-2 overflow-x-auto pb-1">
            {FILTER_PRESETS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilterId(f.id)}
                aria-pressed={f.id === filterId}
                className={cn(
                  "h-11 shrink-0 snap-start rounded-full border px-4 text-sm font-semibold backdrop-blur-md",
                  f.id === filterId ? "border-white bg-white text-black" : "border-white/25 bg-black/50 text-white",
                )}
              >
                {t(`filter_${f.id}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3 pb-safe-b pt-4">
        {recording || paused || counting ? (
          <span className="rounded-full bg-black/50 px-3 py-1 font-mono text-sm font-semibold text-white">
            {formatDuration(recorder.elapsedMs)} / {formatDuration(VIDEO_LIMITS.maxRecordMs)}
          </span>
        ) : null}
        <div className="mb-4 flex items-center gap-8">
          <div className="flex w-14 justify-center">
            {hasContent ? (
              <Button className="h-14 w-14 rounded-full bg-white px-0 text-black hover:bg-white/90" onClick={() => recorder.stop()}>
                {t("done")}
              </Button>
            ) : idle ? (
              <IconButton variant="overlay" size="lg" label={t("gallery")} onClick={props.onGallery}>
                <ImagePlus aria-hidden />
              </IconButton>
            ) : null}
          </div>
          <RecordButton
            state={recorder.state}
            countdownValue={recorder.countdownValue}
            progressPct={recording || paused ? Math.min(100, (recorder.elapsedMs / VIDEO_LIMITS.maxRecordMs) * 100) : 0}
            segments={recorder.segments}
            maxMs={VIDEO_LIMITS.maxRecordMs}
            disabled={camera.status !== "ready"}
            onClick={onMainButton}
            label={recording ? t("pause") : paused ? t("resume") : t("start")}
          />
          <div className="w-14" />
        </div>
        {recorder.error ? <p role="alert" className="max-w-sm px-4 text-center text-sm text-white">{t("recordingError")}</p> : null}
        {idle && camera.status !== "ready" ? <p className="text-xs text-white/70">{t("preparing")}</p> : null}
      </div>
    </ImmersiveSurface>
  );
}
