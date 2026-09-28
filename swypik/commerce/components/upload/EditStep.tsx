"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ImageIcon, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { captureFrame, formatDuration, seekTo, type ProbedFile } from "@/lib/upload/media";
import { clampTrim, type TrimRange } from "@/lib/upload/trim";
import { bindTrimPreview } from "@/lib/upload/preview";
import { TrimControl } from "./TrimControl";
import { StickyActions } from "./StickyActions";

/** Pasul 2: tăiere + alegerea copertei, pe previzualizarea locală (fără să aștepte uploadul). */
export function EditStep(props: {
  previewUrl: string;
  probe: ProbedFile | null;
  trim: TrimRange | null;
  onTrim: (t: TrimRange) => void;
  coverUrl: string | null;
  onCover: (jpeg: Blob, atMs: number) => void;
  onRetake: (() => void) | null;
  onNext: () => void;
  status: ReactNode;
}) {
  const t = useTranslations("videoUpload.edit");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [coverAt, setCoverAt] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [coverError, setCoverError] = useState(false);
  const captureEpoch = useRef(0);
  const { probe, trim } = props;

  const selectedCoverAt = trim ? Math.min(Math.max(coverAt, trim.startMs), trim.endMs) : coverAt;

  useEffect(() => {
    const v = videoRef.current;
    setCoverAt(0);
    setCapturing(false);
    setPreviewError(false);
    setCoverError(false);
    return () => { captureEpoch.current += 1; v?.pause(); };
  }, [props.previewUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !trim) return;
    return bindTrimPreview(v, trim);
  }, [trim, props.previewUrl]);

  const pickCover = async () => {
    const v = videoRef.current;
    if (!v || capturing) return;
    const epoch = ++captureEpoch.current;
    const wasPlaying = !v.paused;
    setCapturing(true);
    setCoverError(false);
    try {
      v.pause();
      await seekTo(v, selectedCoverAt / 1000);
      const blob = await captureFrame(v);
      if (epoch === captureEpoch.current) props.onCover(blob, selectedCoverAt);
    } catch {
      if (epoch === captureEpoch.current) setCoverError(true);
    } finally {
      if (epoch === captureEpoch.current) {
        setCapturing(false);
        if (wasPlaying) void v.play().catch(() => undefined);
      }
    }
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-4 px-gutter py-4">
      <div className="relative mx-auto aspect-[9/16] max-h-[55dvh] overflow-hidden rounded-card bg-black">
        <video
          ref={videoRef}
          src={props.previewUrl}
          className="h-full w-full object-contain"
          controls
          preload="metadata"
          onError={() => setPreviewError(true)}
          playsInline
          aria-label={t("preview")}
        />
      </div>
      <p className="text-sm text-muted">{t("playbackHint")}</p>
      {previewError ? <p role="alert" className="text-sm text-danger">{t("playbackError")}</p> : null}
      {props.status}

      {probe && trim ? (
        <Card className="space-y-5">
          <TrimControl durationMs={probe.durationMs} value={trim} onChange={(v, moved) => { if (!capturing) props.onTrim(clampTrim(v, probe.durationMs, moved)); }} />
          <div className="space-y-2">
            <label htmlFor="cover-at" className="flex justify-between text-sm font-semibold text-fg">
              <span>{t("cover")}</span>
              <span className="text-xs font-normal tabular-nums text-muted">{formatDuration(selectedCoverAt)}</span>
            </label>
            <input
              id="cover-at"
              type="range"
              min={trim.startMs}
              max={trim.endMs}
              step={100}
              disabled={capturing}
              value={selectedCoverAt}
              onChange={(e) => {
                const ms = Number(e.target.value);
                setCoverAt(ms);
                if (videoRef.current) {
                  videoRef.current.pause();
                  videoRef.current.currentTime = ms / 1000;
                }
              }}
              className="h-11 w-full accent-brand"
            />
            <div className="flex items-center gap-3">
              {props.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={props.coverUrl} alt={t("coverChosen")} className="h-16 w-9 rounded-control object-cover" />
              ) : (
                <span className="flex h-16 w-9 items-center justify-center rounded-control bg-surface-2 text-subtle">
                  <ImageIcon className="h-4 w-4" aria-hidden />
                </span>
              )}
              <Button variant="secondary" disabled={previewError} onClick={() => void pickCover()} loading={capturing}>
                <Check className="h-4 w-4" aria-hidden /> {t("useFrame")}
              </Button>
            </div>
            {coverError ? <p role="alert" className="text-sm text-danger">{t("coverError")}</p> : null}
            <p className="text-xs text-muted">{props.coverUrl ? t("coverCustomHint") : t("coverAutoHint")}</p>
          </div>
        </Card>
      ) : (
        <Card variant="muted" className="text-sm text-muted">
          {t("noPreviewHint")}
        </Card>
      )}

      <StickyActions>
        {props.onRetake ? (
          <Button variant="secondary" size="lg" onClick={props.onRetake}>
            <RotateCcw className="h-5 w-5" aria-hidden /> {t("retake")}
          </Button>
        ) : null}
        <Button size="lg" block disabled={capturing} onClick={props.onNext}>
          {t("next")}
        </Button>
      </StickyActions>
    </div>
  );
}
