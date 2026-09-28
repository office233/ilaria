"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHlsVideo } from "@/lib/video/useHlsVideo";
import type { FeedVideo } from "@/lib/feed/types";
import { posterImgProps } from "./useFeedPreload";

export type FeedPlayerProps = {
  video: FeedVideo;
  /** Slide-ul vizibil: redă; restul stau în pauză (vecinii sunt doar preîncărcați). */
  active: boolean;
  /** Posterul transformat pe CDN (același URL pentru <img> și `poster`). */
  posterSrc: string | null;
  /** Primul slide din feed: posterul e LCP → încărcare prioritară. */
  priority: boolean;
  muted: boolean;
  /** false = animații reduse / pagină ascunsă: nu pornim singuri. */
  autoPlay: boolean;
  captionLang: string;
  registerEl: (videoId: string, el: HTMLVideoElement | null) => void;
  onTimeUpdate: (videoId: string, ratio: number, currentTime: number) => void;
};

/**
 * Player-ul unui slide: HLS prin hls.js (sau nativ pe Safari), MP4 de rezervă
 * (`fallbackUrl` = preview.mp4), subtitrări `<track>` din
 * /api/videos/[id]/captions?format=vtt. Tap = pauză / redare.
 */
export default function FeedPlayer({ video, active, posterSrc, priority, muted, autoPlay, captionLang, registerEl, onTimeUpdate }: FeedPlayerProps) {
  const t = useTranslations("explore");
  // Vecinii (preload) țin doar primul segment; la activare bufferul crește, fără re-creare.
  const ref = useHlsVideo(video.hlsUrl || video.url, video.fallbackUrl || video.url, { bufferMode: active ? "active" : "preload" });
  const [paused, setPaused] = useState(true);
  const wasActive = useRef(false);

  useEffect(() => {
    registerEl(video.id, ref.current);
    return () => registerEl(video.id, null);
  }, [video.id, registerEl, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active) {
      if (!wasActive.current) el.currentTime = 0;
      if (autoPlay) el.play().catch(() => setPaused(true));
    } else {
      el.pause();
    }
    wasActive.current = active;
  }, [active, autoPlay, ref]);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  };

  return (
    <>
      {posterSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- poster de pe CDN-ul media (deja transformat); pictat înainte ca <video> să aibă un cadru
        <img src={posterSrc} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" {...posterImgProps(priority)} />
      ) : null}
      <video
        ref={ref}
        className="absolute inset-0 h-full w-full object-cover"
        poster={posterSrc || undefined}
        loop
        muted={muted}
        playsInline
        preload={active ? "auto" : "metadata"}
        aria-label={video.description || t("videoAria")}
        onClick={toggle}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (el.duration) onTimeUpdate(video.id, el.currentTime / el.duration, el.currentTime);
        }}
      >
        {video.captionLangs.map((lang) => (
          <track
            key={lang}
            kind="subtitles"
            srcLang={lang}
            label={lang.toUpperCase()}
            src={`/api/videos/${encodeURIComponent(video.id)}/captions?lang=${lang}&format=vtt`}
            default={lang === captionLang}
          />
        ))}
      </video>
      {active && paused ? (
        <button
          type="button"
          onClick={toggle}
          aria-label={t("play")}
          className="absolute left-1/2 top-1/2 z-10 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-md"
        >
          <Play aria-hidden className="h-8 w-8" />
        </button>
      ) : null}
    </>
  );
}
