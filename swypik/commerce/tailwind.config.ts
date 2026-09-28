import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/** Culoare semantică din app/styles/tokens.css (canale RGB → suportă `/opacity`). */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  // `dark:` se aplică oriunde un strămoș are data-theme="dark": pe <html>
  // (next-themes) SAU pe un wrapper <ImmersiveSurface>.
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: token("canvas"),
        surface: {
          DEFAULT: token("surface"),
          2: token("surface-2"),
        },
        elevated: token("elevated"),
        overlay: token("overlay"),
        fg: {
          DEFAULT: token("fg"),
          muted: token("fg-muted"),
          subtle: token("fg-subtle"),
          inverse: token("fg-inverse"),
        },
        brand: {
          DEFAULT: token("brand"),
          hover: token("brand-hover"),
          fg: token("brand-fg"),
          soft: token("brand-soft"),
          "soft-fg": token("brand-soft-fg"),
          // Aliasuri istorice — folosește `brand` / `accent` în cod nou.
          primary: token("brand"),
          accent: token("accent"),
          indigo: "rgb(79 70 229 / <alpha-value>)",
        },
        accent: token("accent"),
        success: { DEFAULT: token("success"), soft: token("success-soft") },
        warning: { DEFAULT: token("warning"), soft: token("warning-soft") },
        danger: { DEFAULT: token("danger"), soft: token("danger-soft") },
        info: { DEFAULT: token("info"), soft: token("info-soft") },
        // WCAG AA (contrast >= 4.5:1 pe alb) — istoric; preferă success/warning/danger.
        "brand-aa": {
          red: "rgb(220 38 38 / <alpha-value>)",
          amber: "rgb(180 83 9 / <alpha-value>)",
          gray: "rgb(82 82 91 / <alpha-value>)",
        },
      },
      // `text-muted`, `text-subtle` — scurtături pentru nivelurile de text.
      textColor: {
        muted: token("fg-muted"),
        subtle: token("fg-subtle"),
      },
      // `border-subtle` (implicit) și `border-strong`.
      borderColor: {
        DEFAULT: token("border"),
        subtle: token("border"),
        strong: token("border-strong"),
      },
      divideColor: {
        DEFAULT: token("border"),
      },
      ringColor: {
        DEFAULT: token("focus-ring"),
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      borderRadius: {
        control: "var(--radius-md)",
        card: "var(--radius-lg)",
        sheet: "var(--radius-xl)",
      },
      boxShadow: {
        "elev-1": "var(--shadow-1)",
        "elev-2": "var(--shadow-2)",
        "elev-3": "var(--shadow-3)",
        glow: "0 0 40px rgb(124 58 237 / 0.28)",
      },
      spacing: {
        header: "var(--header-h)",
        nav: "var(--nav-h)",
        gutter: "var(--space-gutter)",
        "safe-t": "var(--safe-top)",
        "safe-b": "var(--safe-bottom)",
        "bottom-inset": "var(--bottom-inset)",
      },
      zIndex: {
        nav: "var(--z-nav)",
        header: "var(--z-header)",
        overlay: "var(--z-overlay)",
        toast: "var(--z-toast)",
      },
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, rgb(var(--brand)) 0%, rgb(var(--accent)) 100%)",
      },
      keyframes: {
        "sheet-in-bottom": { from: { transform: "translateY(100%)" }, to: { transform: "translateY(0)" } },
        "sheet-in-left": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(0)" } },
        "sheet-in-right": { from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.96)" }, to: { opacity: "1", transform: "scale(1)" } },
      },
      animation: {
        "sheet-in-bottom": "sheet-in-bottom var(--dur-slow) var(--ease-out)",
        "sheet-in-left": "sheet-in-left var(--dur-slow) var(--ease-out)",
        "sheet-in-right": "sheet-in-right var(--dur-slow) var(--ease-out)",
        "fade-in": "fade-in var(--dur-base) var(--ease-out)",
        "scale-in": "scale-in var(--dur-base) var(--ease-out)",
      },
    },
  },
  plugins: [
    // WCAG 2.2 — target size >= 44px. Hit-area utility for icon buttons.
    plugin(({ addUtilities }) => {
      addUtilities({
        ".hit-target-44": {
          position: "relative",
          minWidth: "44px",
          minHeight: "44px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          touchAction: "manipulation",
        },
      });
    }),
  ],
  future: {
    hoverOnlyWhenSupported: true,
  },
};

export default config;
