"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFeedPage, type FeedQuery } from "@/lib/feed/client/feed-source";
import { getSessionId } from "@/lib/feed/track";
import { logger } from "@/lib/logger";
import type { FeedItem, FeedSource, FeedVideo } from "@/lib/feed/types";
import { withFollowing } from "./patches";

/** Contextul de servire al unui item (logat în impresii: evaluare off-policy). */
export type ServeInfo = { requestId: string | null; position: number; ab: string | null };

const MAX_EMPTY_PAGES = 3;

export type FeedStatus = "loading" | "ready" | "error";

type Params = { source: FeedSource; category?: string; creatorId?: string; pinnedVideoId?: string; locale: string };

export function useFeed({ source, category, creatorId, pinnedVideoId, locale }: Params) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const keysRef = useRef<Set<string>>(new Set());
  const serveRef = useRef<Map<string, ServeInfo>>(new Map());
  const generationRef = useRef(0);
  /** Pagini consecutive fără itemi noi (toți dispăruți/duplicați) — continuăm automat, limitat. */
  const emptyStreakRef = useRef(0);

  const baseQuery = useCallback(
    (): FeedQuery => ({ source, category, creatorId, pinnedVideoId, locale, sessionId: getSessionId() }),
    [source, category, creatorId, pinnedVideoId, locale],
  );

  const load = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current && !reset) return;
      const generation = reset ? ++generationRef.current : generationRef.current;
      loadingRef.current = true;
      let continueAfter = false;
      if (reset) {
        cursorRef.current = null;
        keysRef.current = new Set();
        serveRef.current = new Map();
        setItems([]);
        setStatus("loading");
      }
      try {
        const page = await fetchFeedPage({ ...baseQuery(), cursor: cursorRef.current });
        if (generation !== generationRef.current) return;
        if (!page) {
          if (reset) setStatus("error");
          return;
        }
        const base = keysRef.current.size;
        const fresh = page.items.filter((it) => !keysRef.current.has(it.key));
        fresh.forEach((it, i) => {
          keysRef.current.add(it.key);
          serveRef.current.set(it.key, { requestId: page.requestId, position: base + i, ab: page.ab });
        });
        cursorRef.current = page.nextCursor;
        setHasMore(page.hasMore);
        setItems((cur) => (reset ? fresh : [...cur, ...fresh]));
        setStatus("ready");
        emptyStreakRef.current = fresh.length === 0 ? emptyStreakRef.current + 1 : 0;
        continueAfter = fresh.length === 0 && page.hasMore && emptyStreakRef.current <= MAX_EMPTY_PAGES;
      } catch (err) {
        logger.error({ err }, "[feed] load failed");
        if (generation === generationRef.current && reset) setStatus("error");
      } finally {
        if (generation === generationRef.current) loadingRef.current = false;
      }
      if (continueAfter) void loadRef.current(false);
    },
    [baseQuery],
  );

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
    void load(true);
  }, [load]);

  const loadMore = useCallback(() => {
    if (hasMore) void load(false);
  }, [hasMore, load]);

  const reload = useCallback(() => void load(true), [load]);

  const patchVideo = useCallback((videoId: string, patch: (v: FeedVideo) => FeedVideo) => {
    setItems((cur) => cur.map((it) => (it.kind === "video" && it.video.id === videoId ? { ...it, video: patch(it.video) } : it)));
  }, []);

  const patchCreator = useCallback((creatorId: string, following: boolean) => {
    setItems((cur) => withFollowing(cur, creatorId, following));
  }, []);

  const removeVideo = useCallback((videoId: string) => {
    setItems((cur) => cur.filter((it) => !(it.kind === "video" && it.video.id === videoId)));
  }, []);

  const serveInfo = useCallback((key: string): ServeInfo | undefined => serveRef.current.get(key), []);

  return { items, status, hasMore, loadMore, reload, patchVideo, patchCreator, removeVideo, serveInfo };
}
