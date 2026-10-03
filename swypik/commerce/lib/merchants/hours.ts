/**
 * Program de funcționare pentru comercianți locali.
 *
 * Format `opening_hours` (jsonb):
 *   { "mon": [["09:00","22:00"]], "tue": [["09:00","14:00"],["17:00","22:00"]], ... }
 * Zi lipsă sau listă goală = închis.
 *
 * `is_open_override`: true/false forțează starea (buton „închid acum" din panou),
 * null = se calculează din program.
 */

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type OpeningHours = Partial<Record<DayKey, [string, string][]>>;

const DAYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Fusul orar al comerciantului: după țară (local_merchants.location_country),
 * cu fallback MERCHANT_DEFAULT_TIMEZONE (implicit Europe/Bucharest). Serverul
 * rulează pe UTC. Audit food-go #24: înainte fus fix România pentru toți.
 */
const COUNTRY_TIMEZONES: Record<string, string> = {
  RO: "Europe/Bucharest",
  MD: "Europe/Chisinau",
  BG: "Europe/Sofia",
  HU: "Europe/Budapest",
  DE: "Europe/Berlin",
  AT: "Europe/Vienna",
  IT: "Europe/Rome",
  ES: "Europe/Madrid",
  FR: "Europe/Paris",
  PT: "Europe/Lisbon",
  GB: "Europe/London",
};

export function merchantTimezone(country?: string | null): string {
  const byCountry = country ? COUNTRY_TIMEZONES[country.trim().toUpperCase()] : undefined;
  return byCountry ?? (process.env.MERCHANT_DEFAULT_TIMEZONE || "Europe/Bucharest");
}

function nowInZone(now: Date, timeZone: string): { minutes: number; dayIdx: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Bucharest",
      hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
    }).formatToParts(now);
  }
  return partsToClock(parts, now);
}

function partsToClock(parts: Intl.DateTimeFormatPart[], now: Date): { minutes: number; dayIdx: number } {
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const h = Number(get("hour")) % 24;
  return { minutes: h * 60 + Number(get("minute")), dayIdx: wd === -1 ? now.getDay() : wd };
}

/** Programul e necunoscut (obiect gol — ex. profil importat din OSM fără ore)? */
export function hasKnownHours(hours: unknown): boolean {
  return !!hours && typeof hours === "object" && Object.keys(hours as object).length > 0;
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Este deschis acum?
 * Suportă intervale peste miezul nopții (ex: 18:00–02:00).
 */
export function isOpenNow(
  hours: unknown,
  override?: boolean | null,
  now: Date = new Date(),
  timeZone: string = merchantTimezone(),
): boolean {
  if (override === true) return true;
  if (override === false) return false;

  const oh = (hours ?? {}) as OpeningHours;
  if (!oh || typeof oh !== "object" || Object.keys(oh).length === 0) return false;

  const { minutes: nowMin, dayIdx } = nowInZone(now, timeZone);
  const today = DAYS[dayIdx];
  const yesterday = DAYS[(dayIdx + 6) % 7];

  // interval normal, azi
  for (const [from, to] of oh[today] ?? []) {
    const f = toMinutes(from);
    const t = toMinutes(to);
    if (f === null || t === null) continue;
    if (t > f && nowMin >= f && nowMin < t) return true;
    // interval care trece de miezul nopții, început azi
    if (t <= f && nowMin >= f) return true;
  }

  // interval început ieri și continuat după miezul nopții
  for (const [from, to] of oh[yesterday] ?? []) {
    const f = toMinutes(from);
    const t = toMinutes(to);
    if (f === null || t === null) continue;
    if (t <= f && nowMin < t) return true;
  }

  return false;
}

/** Validare la salvare: structură + ore corecte. */
export function validateOpeningHours(input: unknown): { ok: boolean; error?: string } {
  if (input === undefined || input === null) return { ok: true };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "opening_hours trebuie să fie un obiect" };
  }
  for (const [day, ranges] of Object.entries(input as Record<string, unknown>)) {
    if (!DAYS.includes(day as DayKey)) {
      return { ok: false, error: `zi invalidă: ${day}` };
    }
    if (!Array.isArray(ranges)) {
      return { ok: false, error: `${day}: trebuie listă de intervale` };
    }
    if (ranges.length > 4) {
      return { ok: false, error: `${day}: maxim 4 intervale` };
    }
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2) {
        return { ok: false, error: `${day}: interval invalid` };
      }
      if (toMinutes(String(r[0])) === null || toMinutes(String(r[1])) === null) {
        return { ok: false, error: `${day}: oră invalidă (format HH:MM)` };
      }
    }
  }
  return { ok: true };
}

/** Următoarea deschidere, pentru afișare („Deschide luni la 09:00”). */
export function nextOpening(hours: unknown, now: Date = new Date()): { day: DayKey; time: string } | null {
  const oh = (hours ?? {}) as OpeningHours;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i < 7; i++) {
    const day = DAYS[(now.getDay() + i) % 7];
    const ranges = [...(oh[day] ?? [])].sort((a, b) => (toMinutes(a[0]) ?? 0) - (toMinutes(b[0]) ?? 0));
    for (const [from] of ranges) {
      const f = toMinutes(from);
      if (f === null) continue;
      if (i > 0 || f > nowMin) return { day, time: from };
    }
  }
  return null;
}
