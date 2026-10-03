"use client";

import type { ReactNode } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { THEME_STORAGE_KEY } from "@/lib/theme/theme-color";
import ThemeColorSync from "./ThemeColorSync";

/**
 * Tema aplicației: `data-theme` pe <html>. Implicit urmează sistemul
 * (prefers-color-scheme); alegerea utilizatorului (ThemeToggle) e salvată în
 * localStorage. Scriptul next-themes rulează înainte de hidratare → fără flash.
 */
export default function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      enableColorScheme
      disableTransitionOnChange
      themes={["light", "dark"]}
      storageKey={THEME_STORAGE_KEY}
    >
      <ThemeColorSync />
      {children}
    </NextThemesProvider>
  );
}
