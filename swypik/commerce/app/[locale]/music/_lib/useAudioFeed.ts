"use client";
import { useCallback, useEffect, useState } from "react";
import type { AudioFeedResponse, AudioFeedSection, AudioSourceType } from "@/lib/audio/types";
import type { MusicHomeRow } from "@/lib/music/home";

export type AudioTabId = "all" | "radio" | "audius" | "jamendo" | "podcast";

type FeedState = { sections: AudioFeedSection[] | null; unconfigured: AudioSourceType[]; failed: boolean };

/** Secțiunile externe (radio, Audius, Jamendo, podcasturi) pentru un tab; fără date false la eșec. */
export function useAudioFeed(tab: AudioTabId) {
  const [state, setState] = useState<FeedState>({ sections: null, unconfigured: [], failed: false });
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, sections: null, failed: false }));
    fetch(`/api/audio/feed?tab=${tab}`)
      .then((r) => (r.ok ? (r.json() as Promise<AudioFeedResponse>) : Promise.reject(r.status)))
      .then((d) => { if (!cancelled) setState({ sections: d.sections ?? [], unconfigured: d.unconfigured ?? [], failed: false }); })
      .catch(() => { if (!cancelled) setState((s) => ({ ...s, sections: [], failed: true })); });
    return () => { cancelled = true; };
  }, [tab, tick]);

  return { ...state, retry };
}

export type AudioFeed = ReturnType<typeof useAudioFeed>;

/** Rândurile catalogului propriu Swypik (/api/music/home). */
export function useCatalogRows() {
  const [rows, setRows] = useState<MusicHomeRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/music/home")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { rows?: MusicHomeRow[] }) => { if (!cancelled) setRows(d.rows ?? []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);
  return rows;
}
