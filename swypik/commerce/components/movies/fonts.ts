import { Bebas_Neue } from "next/font/google";

/**
 * Fontul de afișare al Swypik Movies (wordmark, titluri, cifrele din Top 10).
 * Bebas Neue (OFL) dă aspectul condensat al literelor din logo-ul Netflix;
 * Netflix Sans este proprietar și nu se poate folosi. Textul curent rămâne pe
 * fontul aplicației. Se aplică prin variabila CSS `--font-movies-display`.
 */
export const moviesDisplayFont = Bebas_Neue({
    weight: "400",
    subsets: ["latin", "latin-ext"],
    display: "swap",
    variable: "--font-movies-display",
    fallback: ["Impact", "Arial Narrow", "sans-serif"],
});

/** Clasă utilitară pentru elemente care folosesc fontul de afișare. */
export const MOVIES_DISPLAY_CLASS = "movies-display";
