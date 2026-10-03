/**
 * Filter presets pentru Reels recorder.
 * - `css` se aplică pe `<video>` (preview live) și pe `ctx.filter` (canvas bake)
 * - `id` "none" = no-op, evită canvas pipeline
 */

export type FilterId =
  | "none"
  | "warm"
  | "cool"
  | "vivid"
  | "mono"
  | "sepia"
  | "fade";

export interface FilterPreset {
  id: FilterId;
  label: string;
  /** CSS filter string (compatible cu canvas `ctx.filter`) */
  css: string;
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: "none", label: "Original", css: "none" },
  { id: "warm", label: "Cald", css: "saturate(1.15) sepia(0.18) contrast(1.05)" },
  { id: "cool", label: "Rece", css: "saturate(1.1) hue-rotate(-12deg) brightness(1.02)" },
  { id: "vivid", label: "Vibrant", css: "saturate(1.5) contrast(1.12)" },
  { id: "mono", label: "Alb-negru", css: "grayscale(1) contrast(1.1)" },
  { id: "sepia", label: "Sepia", css: "sepia(0.85) saturate(1.1)" },
  { id: "fade", label: "Fade", css: "saturate(0.78) brightness(1.08) contrast(0.95)" },
];

export function getFilter(id: FilterId): FilterPreset {
  return FILTER_PRESETS.find((f) => f.id === id) ?? FILTER_PRESETS[0];
}
