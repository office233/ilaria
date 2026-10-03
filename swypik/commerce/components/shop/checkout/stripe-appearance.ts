import type { Appearance } from "@stripe/stripe-js";

/** Tokenii sunt canale „R G B”; Stripe vrea culori CSS complete. */
function token(name: string, fallbackVar: string): string {
  if (typeof window === "undefined") return fallbackVar;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return raw ? `rgb(${raw.split(/\s+/).join(", ")})` : fallbackVar;
}

/**
 * Aspectul Stripe Elements derivat din tokenii design-system-ului, deci
 * urmează automat tema (light/dark). Iframe-ul Stripe nu vede variabilele CSS
 * ale paginii, așa că le citim o dată la montare.
 */
export function stripeAppearance(): Appearance {
  const dark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
  return {
    theme: dark ? "night" : "stripe",
    variables: {
      colorPrimary: token("brand", "currentColor"),
      colorBackground: token("surface", "Canvas"),
      colorText: token("fg", "CanvasText"),
      colorDanger: token("danger", "currentColor"),
      colorTextSecondary: token("fg-muted", "GrayText"),
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      fontSizeBase: "16px",
      spacingUnit: "4px",
      borderRadius: "12px",
    },
    rules: {
      ".Input": { border: `1px solid ${token("border", "currentColor")}`, boxShadow: "none", padding: "12px 14px" },
      ".Input:focus": { border: `1px solid ${token("brand", "currentColor")}`, boxShadow: "none" },
      ".Label": { fontWeight: "500", fontSize: "14px" },
    },
  };
}
