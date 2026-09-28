import { VIDEO_PLAYBACK } from "@/lib/config/video-playback";

/**
 * Planul de preîncărcare al feed-ului vertical (pur, testat unitar).
 *
 *   - `active`  — clipul vizibil: player atașat, buffer complet;
 *   - `preload` — vecinii ±attachRadius: player atașat, buffer minim, în pauză;
 *   - `idle`    — restul: fără player (doar poster), media eliberată.
 *
 * Pe rețea economică (Data Saver / 2G) nu preîncărcăm nimic în afara clipului activ.
 */
export type SlotState = "active" | "preload" | "idle";

export type NetworkInfo = { saveData?: boolean; effectiveType?: string };

export function isConstrainedNetwork(connection: NetworkInfo | null | undefined): boolean {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  const type = connection.effectiveType;
  return typeof type === "string" && (VIDEO_PLAYBACK.slowEffectiveTypes as readonly string[]).includes(type);
}

export function slotState(index: number, activeIndex: number, constrained: boolean): SlotState {
  if (index === activeIndex) return "active";
  if (constrained) return "idle";
  return Math.abs(index - activeIndex) <= VIDEO_PLAYBACK.attachRadius ? "preload" : "idle";
}

/**
 * Indecșii de după clipul activ (până la `preloadAhead`) care NU au player atașat
 * → pentru ei preîncărcăm doar manifestul HLS și posterul.
 */
export function hintIndexes(activeIndex: number, count: number, constrained: boolean): number[] {
  if (constrained) return [];
  const out: number[] = [];
  const last = Math.min(count - 1, activeIndex + VIDEO_PLAYBACK.preloadAhead);
  for (let i = activeIndex + 1; i <= last; i += 1) {
    if (slotState(i, activeIndex, constrained) === "idle") out.push(i);
  }
  return out;
}

/** Cea mai mică lățime din listă care acoperă viewportul în pixeli fizici. */
export function posterWidth(cssWidth: number, devicePixelRatio: number): number {
  const widths = VIDEO_PLAYBACK.posterWidths;
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) return VIDEO_PLAYBACK.defaultPosterWidth;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const needed = Math.ceil(cssWidth * dpr);
  return widths.find((w) => w >= needed) ?? widths[widths.length - 1];
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}
