/**
 * Paleta emailurilor — echivalentul hex al tokenurilor din app/styles/tokens.css
 * (tema light). Clienții de email nu citesc variabile CSS, așa că valorile
 * sunt copiate aici O SINGURĂ DATĂ; toate șabloanele folosesc doar acest obiect.
 * Dacă schimbi un token de brand, actualizează și maparea de mai jos.
 */
const rgb = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

export const EMAIL_THEME = {
  canvas: rgb(247, 247, 248), // --canvas
  surface: rgb(255, 255, 255), // --surface
  surface2: rgb(240, 240, 242), // --surface-2
  fg: rgb(13, 13, 13), // --fg
  fgMuted: rgb(82, 82, 91), // --fg-muted
  fgSubtle: rgb(113, 113, 122), // --fg-subtle
  fgInverse: rgb(255, 255, 255), // --fg-inverse
  border: rgb(228, 228, 231), // --border
  brand: rgb(124, 58, 237), // --brand
  brandFg: rgb(255, 255, 255), // --brand-fg
  brandSoft: rgb(237, 233, 254), // --brand-soft
  brandSoftFg: rgb(91, 33, 182), // --brand-soft-fg
  danger: rgb(220, 38, 38), // --danger
  dangerSoft: rgb(254, 226, 226), // --danger-soft
  success: rgb(21, 128, 61), // --success
  successSoft: rgb(220, 252, 231), // --success-soft
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const;
