import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge cunoaște clasele custom din tailwind.config.ts (umbre, raze,
 * culori de text semantice) ca să le rezolve conflictele corect:
 * `cn("shadow-elev-1", "shadow-elev-3")` → `shadow-elev-3`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["elev-1", "elev-2", "elev-3", "glow"] }],
      rounded: [{ rounded: ["control", "card", "sheet"] }],
      "text-color": [{ text: ["muted", "subtle"] }],
    },
  },
});

/** Compune clase condiționale și elimină conflictele Tailwind (ultima câștigă). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
