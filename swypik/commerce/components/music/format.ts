/**
 * Utilitare de formatare pentru Swypik Music.
 */

/** Durata în milisecunde → „m:ss" (ex.: 183400 → „3:03"). */
export function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
