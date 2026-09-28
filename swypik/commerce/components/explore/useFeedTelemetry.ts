"use client";

import { useCallback, useEffect, useRef } from "react";
import { flushWatchTime, resetWatchTime, trackEvent, trackWatchTime } from "@/lib/feed/track";
import type { FeedItem } from "@/lib/feed/types";
import type { ServeInfo } from "./useFeed";

/** View real = 3s de redare efectivă (nu doar vizibilitate). */
const VIEW_AFTER_MS = 3000;
/** Swipe sub 2s fără nicio buclă completă = skip_fast. */
const SKIP_FAST_MS = 2000;

type LoopState = { lastRatio: number; loops: number };

/**
 * Evenimentele de ranking ale feed-ului (lib/feed/track → /api/feed/events/batch):
 * impression (cu request_id/poziție/variantă A/B), video_view, watch_time,
 * completion/rewatch (clipurile rulează în buclă → detectăm trecerea 1→0),
 * skip_fast. Ingest-ul (gărzi anti-abuz) rămâne pe server.
 */
export function useFeedTelemetry(getVideoEl: (videoId: string) => HTMLVideoElement | null) {
  const loops = useRef<Map<string, LoopState>>(new Map());
  const viewTimers = useRef<Map<string, number>>(new Map());
  const viewed = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timers = viewTimers.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, []);

  const sendView = useCallback((videoId: string) => {
    if (viewed.current.has(videoId)) return;
    viewed.current.add(videoId);
    fetch(`/api/videos/${encodeURIComponent(videoId)}/view`, { method: "POST" }).catch(() => undefined);
    trackEvent("video_view", { video_id: videoId });
  }, []);

  const onActivate = useCallback(
    (item: FeedItem, serve: ServeInfo | undefined) => {
      const metadata = { request_id: serve?.requestId ?? null, position: serve?.position ?? null, ab: serve?.ab ?? null };
      if (item.kind !== "video") {
        trackEvent("impression", { metadata: { ...metadata, card_kind: item.kind, card_id: item.card.id } });
        return;
      }
      const id = item.video.id;
      loops.current.set(id, { lastRatio: 0, loops: 0 });
      trackEvent("impression", { video_id: id, metadata });
      const timer = window.setTimeout(() => {
        const el = getVideoEl(id);
        if (el && !el.paused && !el.ended && el.currentTime > 0) sendView(id);
      }, VIEW_AFTER_MS);
      viewTimers.current.set(id, timer);
    },
    [getVideoEl, sendView],
  );

  const onDeactivate = useCallback((item: FeedItem) => {
    if (item.kind !== "video") return;
    const id = item.video.id;
    const timer = viewTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    viewTimers.current.delete(id);
    const watchedMs = flushWatchTime(id);
    resetWatchTime(id);
    const completedLoops = loops.current.get(id)?.loops ?? 0;
    if (watchedMs > 0 && watchedMs < SKIP_FAST_MS && completedLoops === 0) {
      trackEvent("skip_fast", { video_id: id });
    }
  }, []);

  const onTimeUpdate = useCallback((videoId: string, ratio: number, currentTime: number) => {
    let state = loops.current.get(videoId);
    if (!state) {
      state = { lastRatio: 0, loops: 0 };
      loops.current.set(videoId, state);
    }
    if (ratio < 0.2 && state.lastRatio > 0.8) {
      state.loops += 1;
      flushWatchTime(videoId);
      resetWatchTime(videoId);
      trackEvent(state.loops === 1 ? "completion" : "rewatch", { video_id: videoId });
    }
    state.lastRatio = ratio;
    trackWatchTime(videoId, Math.round(currentTime * 1000));
  }, []);

  return { onActivate, onDeactivate, onTimeUpdate };
}
