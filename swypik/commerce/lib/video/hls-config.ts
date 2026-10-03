import type { HlsConfig } from "hls.js";
import { VIDEO_PLAYBACK } from "@/lib/config/video-playback";

/**
 * Configurația hls.js comună tuturor playerelor (feed, episod Movies, trailer).
 * Import doar de tip → hls.js rămâne încărcat dinamic, în afara bundle-ului.
 */

/** `active` = clipul care rulează; `preload` = vecin atașat, cu buffer minim. */
export type HlsBufferMode = "active" | "preload";

type BufferConfig = Pick<HlsConfig, "maxBufferLength" | "maxMaxBufferLength" | "backBufferLength" | "maxBufferSize">;

export function hlsBufferConfig(mode: HlsBufferMode): BufferConfig {
  return { ...(mode === "active" ? VIDEO_PLAYBACK.activeBuffer : VIDEO_PLAYBACK.preloadBuffer) };
}

export function hlsConfig(mode: HlsBufferMode = "active"): Partial<HlsConfig> {
  return {
    enableWorker: true,
    lowLatencyMode: false,
    // ABR automat: pornește de la estimarea conservatoare de bandă (redare mică,
    // prima imagine rapid) și urcă singur; nu depășește mărimea playerului.
    startLevel: -1,
    capLevelToPlayerSize: true,
    abrEwmaDefaultEstimate: VIDEO_PLAYBACK.initialBandwidthBps,
    ...hlsBufferConfig(mode),
  };
}
