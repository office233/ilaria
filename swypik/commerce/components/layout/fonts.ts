import { Inter } from "next/font/google";

/**
 * Fontul aplicației: Inter (self-hosted de next/font, fără request la runtime
 * către Google, `display: swap`). latin-ext pentru diacriticele românești.
 * Expus ca variabila CSS `--font-sans` (vezi tailwind.config.ts, globals.css).
 */
export const interFont = Inter({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-sans",
});
