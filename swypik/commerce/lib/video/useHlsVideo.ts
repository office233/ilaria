"use client";

import { useEffect, useRef } from "react";
import type HlsType from "hls.js";
import { VIDEO_PLAYBACK } from "@/lib/config/video-playback";
import { isHlsUrl } from "./feed-preload";
import { hlsBufferConfig, hlsConfig, type HlsBufferMode } from "./hls-config";

export type UseHlsVideoOptions = {
  /**
   * `active` (implicit) = buffer complet; `preload` = vecin preîncărcat, doar
   * primul segment. Schimbarea modului NU recreează playerul — ajustează bufferul.
   */
  bufferMode?: HlsBufferMode;
};

/**
 * useHlsVideo
 *
 * Returns a ref to attach to a <video> element. When `src` ends in `.m3u8`,
 * playback is wired through hls.js (or native HLS on Safari/iOS). For plain
 * mp4 (or any other src) the URL is assigned directly.
 *
 * Note: the hook sets `video.src` itself — do NOT also pass `src` to the
 * <video> element, or hls.js will fight the native loader.
 *
 * hls.js is loaded dynamically only when needed (non-Safari + HLS source),
 * keeping it out of the main bundle. Config comes from `lib/video/hls-config.ts`
 * (shared by feed, Movies episode and hero trailer).
 */
export function useHlsVideo(src: string | undefined | null, fallbackSrc?: string | undefined | null, options: UseHlsVideoOptions = {}) {
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const bufferMode = options.bufferMode ?? "active";
  const modeRef = useRef<HlsBufferMode>(bufferMode);
  modeRef.current = bufferMode;

  // Vecinul preîncărcat devine activ (sau invers): doar bufferul se schimbă;
  // stream-controller-ul hls.js citește aceste valori la fiecare tick.
  useEffect(() => {
    const hls = hlsRef.current;
    if (hls) Object.assign(hls.config, hlsBufferConfig(bufferMode));
  }, [bufferMode]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;

    // La demontare/schimbare de sursă nu e destul să distrugem instanța hls.js:
    // pe căile progressive și HLS-nativ elementul rămânea atașat la sursă și
    // continua să tragă date în fundal (audit perf 2026-08-24).
    const releaseElement = () => {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // Elementul poate fi deja detașat din DOM — nimic de făcut.
      }
    };

    // Progressive (mp4/webm) sau HLS nativ (Safari/iOS: CPU mai mic, fără hls.js);
    // cât de mult se descarcă decide atributul `preload` al elementului.
    if (!isHlsUrl(src) || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return releaseElement;
    }

    let cancelled = false;
    let fallbackTried = false;
    let networkRecoveries = 0;
    let mediaRecoveries = 0;

    const destroyHls = () => {
      try {
        hlsRef.current?.destroy();
      } catch {
        // ignore
      }
      hlsRef.current = null;
    };

    const fallbackToProgressive = () => {
      if (cancelled || fallbackTried || !fallbackSrc || fallbackSrc === src) return;
      fallbackTried = true;
      // Repornim redarea DOAR dacă acest clip chiar rula. Altfel, un clip vecin
      // al cărui master.m3u8 dă 404 (stare normală cât e în procesare) începea
      // să ruleze în afara ecranului, în buclă, la nesfârșit.
      const wasPlaying = !video.paused;
      destroyHls();
      video.src = fallbackSrc;
      video.load();
      if (wasPlaying) void video.play().catch(() => {});
    };

    const onVideoError = () => fallbackToProgressive();
    video.addEventListener("error", onVideoError);

    void (async () => {
      try {
        const Hls = (await import("hls.js")).default;
        if (cancelled || !ref.current) return;
        if (!Hls.isSupported()) {
          // Last-ditch fallback: the error (if any) surfaces via <video> onError.
          video.src = src;
          return;
        }
        const hls = new Hls(hlsConfig(modeRef.current));
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < VIDEO_PLAYBACK.maxNetworkRecoveries) {
            networkRecoveries += 1;
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < VIDEO_PLAYBACK.maxMediaRecoveries) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
            return;
          }
          fallbackToProgressive();
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } catch {
        // Failed to load hls.js — fallback to direct src assignment.
        if (!cancelled) video.src = src;
      }
    })();

    return () => {
      cancelled = true;
      video.removeEventListener("error", onVideoError);
      destroyHls();
      releaseElement();
    };
  }, [src, fallbackSrc]);

  return ref;
}
