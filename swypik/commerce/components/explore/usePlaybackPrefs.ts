"use client";

import { useCallback, useEffect, useState } from "react";

const MUTE_STORAGE_KEY = "swypik.feed.muted";

/** Sunet oprit implicit (autoplay permis de browsere); alegerea se ține minte local. */
export function useMutedPreference(): [boolean, (muted: boolean) => void] {
  const [muted, setMutedState] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(MUTE_STORAGE_KEY) === "0") setMutedState(false);
    } catch {
      // localStorage indisponibil (mod privat) — rămâne implicitul.
    }
  }, []);
  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // idem
    }
  }, []);
  return [muted, setMuted];
}

/** false cât timp tab-ul e ascuns → clipul activ intră în pauză. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
