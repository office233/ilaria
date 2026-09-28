/**
 * Culorile barei de sistem (meta theme-color, manifest). Trebuie să corespundă
 * tokenurilor `--surface` din app/styles/tokens.css (hex aici pentru că meta
 * tag-ul nu acceptă variabile CSS).
 */
export const THEME_COLORS = {
  light: "#FFFFFF", // --surface light (255 255 255)
  dark: "#141417", // --surface dark (20 20 23)
  immersive: "#000000", // feed video / player
} as const;

export type ThemeName = "light" | "dark";
export type ThemePreference = ThemeName | "system";

export const THEME_STORAGE_KEY = "swypik-theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"] as const;

/** Culoarea barei de sistem pentru tema rezolvată și starea imersivă. */
export function themeColorFor(resolved: string | undefined, immersive: boolean): string {
  if (immersive) return THEME_COLORS.immersive;
  return resolved === "dark" ? THEME_COLORS.dark : THEME_COLORS.light;
}
