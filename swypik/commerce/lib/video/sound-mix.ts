/**
 * „Adaugă sunet” = sunetul ales e MIXAT în clip de workerul video (ffmpeg
 * amix, vezi workers/video-worker/video_worker/sound_mix.py), nu doar o
 * etichetă. Setările (volum, păstrează audio original, buclă, de unde începe
 * piesa) stau în `videos.metadata.sound_mix`; piesa în `videos.audio_track_id`.
 *
 * Workerul citește setările din DB la transcodare și scrie în
 * `metadata.sound_mixed_key` cheia a ceea ce a mixat efectiv. Când creatorul
 * schimbă sunetul după procesare, cheile diferă → re-transcodare din sursa
 * păstrată (reprocessVideo reencode). Formatul cheii e identic în worker.
 *
 * Doar piese active și licențiate pentru uz comercial (lib/audio/license.ts;
 * validarea pe server e în lib/video/sound-track.ts). Modul pur (și în client).
 */
import { z } from "zod";

/** Limitele mixului (procente de volum, offset în piesă). */
export const SOUND_MIX_LIMITS = Object.freeze({
  volumeMaxPct: 200,
  defaultVolumePct: 100,
  defaultOriginalVolumePct: 100,
  /** De unde poate începe piesa (ms) — max 10 minute. */
  startMaxMs: 10 * 60 * 1000,
});

export const SoundMixSchema = z
  .object({
    volume: z.number().int().min(0).max(SOUND_MIX_LIMITS.volumeMaxPct).optional(),
    original_volume: z.number().int().min(0).max(SOUND_MIX_LIMITS.volumeMaxPct).optional(),
    keep_original: z.boolean().optional(),
    loop: z.boolean().optional(),
    start_ms: z.number().int().min(0).max(SOUND_MIX_LIMITS.startMaxMs).optional(),
  })
  .strict();

export type SoundMixInput = z.infer<typeof SoundMixSchema>;

export type SoundMix = {
  volume: number;
  original_volume: number;
  keep_original: boolean;
  loop: boolean;
  start_ms: number;
};

export const DEFAULT_SOUND_MIX: SoundMix = Object.freeze({
  volume: SOUND_MIX_LIMITS.defaultVolumePct,
  original_volume: SOUND_MIX_LIMITS.defaultOriginalVolumePct,
  keep_original: true,
  loop: true,
  start_ms: 0,
});

function clampInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, Math.round(n)));
}

/** Setările efective (valorile lipsă/invalide → implicite). Pur. */
export function normalizeSoundMix(raw: unknown): SoundMix {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    volume: clampInt(r.volume, DEFAULT_SOUND_MIX.volume, SOUND_MIX_LIMITS.volumeMaxPct),
    original_volume: clampInt(r.original_volume, DEFAULT_SOUND_MIX.original_volume, SOUND_MIX_LIMITS.volumeMaxPct),
    keep_original: typeof r.keep_original === "boolean" ? r.keep_original : DEFAULT_SOUND_MIX.keep_original,
    loop: typeof r.loop === "boolean" ? r.loop : DEFAULT_SOUND_MIX.loop,
    start_ms: clampInt(r.start_ms, DEFAULT_SOUND_MIX.start_ms, SOUND_MIX_LIMITS.startMaxMs),
  };
}

/** Cheia mixului — identică cu `sound_key()` din worker. `"none"` = fără sunet adăugat. */
export function soundMixKey(trackId: number | string | null | undefined, raw: unknown): string {
  const id = trackId === null || trackId === undefined || trackId === "" ? null : Number(trackId);
  if (id === null || !Number.isFinite(id) || id <= 0) return "none";
  const m = normalizeSoundMix(raw);
  return `t${Math.trunc(id)}-v${m.volume}-o${m.original_volume}-k${m.keep_original ? 1 : 0}-l${m.loop ? 1 : 0}-s${m.start_ms}`;
}
