"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_DETAILS } from "@/lib/upload/details";
import { detailsDraft, type DetailsDraft } from "@/lib/upload/draft-store";
import type { OwnedVideoDto } from "@/lib/upload/api";
import { normalizeSoundMix } from "@/lib/video/sound-mix";

const AUTOSAVE_MS = 600;

export function detailsFromVideo(v: OwnedVideoDto): DetailsDraft {
  const mix = normalizeSoundMix(v.sound_mix);
  return {
    ...EMPTY_DETAILS,
    title: v.title ?? "",
    description: v.description ?? "",
    productId: v.product_refs?.[0]?.product_id ?? null,
    productTitle: v.product_title,
    productOverlaySec: v.product_overlay_ms ? v.product_overlay_ms / 1000 : 0,
    missionId: v.mission_id,
    audioTrackId: v.audio_track_id,
    audioTrackLabel: v.audio_track_label ?? null,
    soundVolume: mix.volume,
    soundOriginalVolume: mix.original_volume,
    soundKeepOriginal: mix.keep_original,
    soundLoop: mix.loop,
    allowComments: v.allow_comments,
    allowDuet: v.allow_duet,
    allowStitch: v.allow_stitch,
    captionsEnabled: v.captions_enabled,
  };
}

/**
 * Starea formularului „Detalii”, salvată automat local (per clip) ca textul
 * tastat să nu se piardă dacă pagina se reîncarcă înainte de „Salvează”.
 */
export function useDetailsForm(videoId: string | null, initial?: Partial<DetailsDraft>) {
  const [details, setDetails] = useState<DetailsDraft>({ ...EMPTY_DETAILS, ...initial });
  const hydrated = useRef<string | null>(null);

  useEffect(() => {
    if (!videoId || hydrated.current === videoId) return;
    hydrated.current = videoId;
    const saved = detailsDraft.load(videoId);
    if (saved) setDetails((cur) => ({ ...cur, ...saved }));
  }, [videoId]);

  useEffect(() => {
    if (!videoId) return;
    const timer = setTimeout(() => detailsDraft.save(videoId, details), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [videoId, details]);

  const update = useCallback(<K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) => {
    setDetails((cur) => ({ ...cur, [key]: value }));
  }, []);

  const replace = useCallback((next: DetailsDraft) => setDetails(next), []);

  return { details, update, replace };
}
