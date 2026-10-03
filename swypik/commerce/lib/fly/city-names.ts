/**
 * Locale-aware city display names for /fly.
 *
 * `lib/fly/airports.ts` and `lib/fly/destinations.ts` store the Romanian city
 * name (source data, used for IATA/alias search matching). Many cities have a
 * well-known exonym in other locales (București → Bucharest, Roma → Rome,
 * Viena → Vienna…). This map supplies those overrides; cities with no entry
 * (or no override for a given locale) simply keep the Romanian name, which is
 * also the correct name in most locales (Paris, Madrid, Berlin, …).
 *
 * IMPORTANT: this is a *display* concern only — search must keep matching in
 * any language, so `searchAirports` in airports.ts still matches against the
 * Romanian city name AND the `aliases` list (which already carries common
 * English forms). Do not remove the Romanian `city` field; only use this map
 * to pick what's *shown* to the user.
 */

export type FlyLocale = "ro" | "en" | "es" | "fr" | "de" | "pt" | "it";

const SUPPORTED_LOCALES: readonly FlyLocale[] = ["ro", "en", "es", "fr", "de", "pt", "it"];

// Keyed by the Romanian city name exactly as stored in AIRPORTS / POPULAR_DESTINATIONS.
const CITY_EXONYMS: Record<string, Partial<Record<Exclude<FlyLocale, "ro">, string>>> = {
  "București": { en: "Bucharest", es: "Bucarest", fr: "Bucarest", de: "Bukarest", pt: "Bucareste", it: "Bucarest" },
  "Timișoara": { en: "Timisoara", es: "Timisoara", fr: "Timisoara", de: "Temeswar", pt: "Timisoara", it: "Timisoara" },
  "Iași": { en: "Iasi", es: "Iasi", fr: "Iasi", de: "Jassy", pt: "Iasi", it: "Iasi" },
  "Constanța": { en: "Constanta", es: "Constanza", fr: "Constanța", de: "Konstanza", pt: "Constança", it: "Costanza" },
  "Bacău": { en: "Bacau", es: "Bacau", fr: "Bacau", de: "Bacau", pt: "Bacau", it: "Bacau" },
  "Târgu Mureș": { en: "Targu Mures", es: "Targu Mures", fr: "Targu Mures", de: "Neumarkt am Mieresch", pt: "Targu Mures", it: "Targu Mures" },
  "Viena": { en: "Vienna", es: "Viena", fr: "Vienne", de: "Wien", pt: "Viena", it: "Vienna" },
  "Londra": { en: "London", es: "Londres", fr: "Londres", de: "London", pt: "Londres", it: "Londra" },
  "Roma": { en: "Rome", es: "Roma", fr: "Rome", de: "Rom", pt: "Roma", it: "Roma" },
  "Veneția": { en: "Venice", es: "Venecia", fr: "Venise", de: "Venedig", pt: "Veneza", it: "Venezia" },
  "Napoli": { en: "Naples", es: "Nápoles", fr: "Naples", de: "Neapel", pt: "Nápoles", it: "Napoli" },
  "Lisabona": { en: "Lisbon", es: "Lisboa", fr: "Lisbonne", de: "Lissabon", pt: "Lisboa", it: "Lisbona" },
  "Atena": { en: "Athens", es: "Atenas", fr: "Athènes", de: "Athen", pt: "Atenas", it: "Atene" },
  "Salonic": { en: "Thessaloniki", es: "Salónica", fr: "Thessalonique", de: "Thessaloniki", pt: "Salónica", it: "Salonicco" },
  "Rodos": { en: "Rhodes", es: "Rodas", fr: "Rhodes", de: "Rhodos", pt: "Rodes", it: "Rodi" },
  "Corfu": { en: "Corfu", es: "Corfú", fr: "Corfou", de: "Korfu", pt: "Corfu", it: "Corfù" },
  "München": { en: "Munich", es: "Múnich", fr: "Munich", de: "München", pt: "Munique", it: "Monaco di Baviera" },
  "Köln": { en: "Cologne", es: "Colonia", fr: "Cologne", de: "Köln", pt: "Colónia", it: "Colonia" },
  "Nürnberg": { en: "Nuremberg", es: "Núremberg", fr: "Nuremberg", de: "Nürnberg", pt: "Nuremberga", it: "Norimberga" },
  "Düsseldorf": { en: "Dusseldorf", es: "Düsseldorf", fr: "Düsseldorf", de: "Düsseldorf", pt: "Düsseldorf", it: "Düsseldorf" },
  "Bruxelles": { en: "Brussels", es: "Bruselas", fr: "Bruxelles", de: "Brüssel", pt: "Bruxelas", it: "Bruxelles" },
  "Zürich": { en: "Zurich", es: "Zúrich", fr: "Zurich", de: "Zürich", pt: "Zurique", it: "Zurigo" },
  "Geneva": { en: "Geneva", es: "Ginebra", fr: "Genève", de: "Genf", pt: "Genebra", it: "Ginevra" },
  "Copenhaga": { en: "Copenhagen", es: "Copenhague", fr: "Copenhague", de: "Kopenhagen", pt: "Copenhaga", it: "Copenaghen" },
  "Praga": { en: "Prague", es: "Praga", fr: "Prague", de: "Prag", pt: "Praga", it: "Praga" },
  "Varșovia": { en: "Warsaw", es: "Varsovia", fr: "Varsovie", de: "Warschau", pt: "Varsóvia", it: "Varsavia" },
  "Cracovia": { en: "Krakow", es: "Cracovia", fr: "Cracovie", de: "Krakau", pt: "Cracóvia", it: "Cracovia" },
  "Belgrad": { en: "Belgrade", es: "Belgrado", fr: "Belgrade", de: "Belgrad", pt: "Belgrado", it: "Belgrado" },
  "Chișinău": { en: "Chisinau", es: "Chisináu", fr: "Chisinau", de: "Chisinau", pt: "Chisinau", it: "Chisinau" },
  "Nisa": { en: "Nice", es: "Niza", fr: "Nice", de: "Nizza", pt: "Nice", it: "Nizza" },
  "Marsilia": { en: "Marseille", es: "Marsella", fr: "Marseille", de: "Marseille", pt: "Marselha", it: "Marsiglia" },
};

/** Resolves the display name for a city stored (in Romanian) in AIRPORTS/POPULAR_DESTINATIONS. */
export function localizedCityName(cityRo: string, locale: string): string {
  if (locale === "ro") return cityRo;
  const l = (SUPPORTED_LOCALES as readonly string[]).includes(locale) ? (locale as FlyLocale) : "en";
  if (l === "ro") return cityRo;
  return CITY_EXONYMS[cityRo]?.[l] ?? cityRo;
}
