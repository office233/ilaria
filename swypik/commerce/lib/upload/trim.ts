/** Logica pură a tăierii (trim) din pasul „Editare”, aliniată la limitele comune. */
import { VIDEO_LIMITS } from "@/lib/video/limits";

export type TrimRange = { startMs: number; endMs: number };

/** Intervalul implicit: tot clipul, tăiat la durata maximă permisă. */
export function defaultTrim(durationMs: number): TrimRange {
  return { startMs: 0, endMs: Math.min(durationMs, VIDEO_LIMITS.maxDurationMs) };
}

/** Ajustează capetele ca intervalul să respecte min/max (păstrând capătul mutat). */
export function clampTrim(next: TrimRange, durationMs: number, moved: "start" | "end"): TrimRange {
  let startMs = Math.max(0, Math.min(next.startMs, durationMs));
  let endMs = Math.max(0, Math.min(next.endMs, durationMs));
  const min = Math.min(VIDEO_LIMITS.minDurationMs, durationMs);
  const max = VIDEO_LIMITS.maxDurationMs;
  if (moved === "start") {
    if (endMs - startMs < min) startMs = Math.max(0, endMs - min);
    if (endMs - startMs > max) endMs = startMs + max;
  } else {
    if (endMs - startMs < min) endMs = Math.min(durationMs, startMs + min);
    if (endMs - startMs > max) startMs = endMs - max;
  }
  return { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

/** Trim-ul trimis serverului: null pe capetele care nu taie nimic. */
export function trimForServer(range: TrimRange | null, durationMs: number | null): { startMs: number | null; endMs: number | null } {
  if (!range || !durationMs) return { startMs: null, endMs: null };
  return {
    startMs: range.startMs > 0 ? range.startMs : null,
    endMs: range.endMs < durationMs ? range.endMs : null,
  };
}
