/**
 * Parametrii Swypik Movies. Toate valorile vin din env cu fallback explicit —
 * niciun număr magic în rute sau componente.
 */
import { intEnv } from "@/lib/config/env";

/** Cota creatorului din fiecare deblocare, în basis points (7000 = 70 %). */
export const MOVIES_CREATOR_SHARE_BPS = intEnv("MOVIES_CREATOR_SHARE_BPS", 7000, 0, 10_000);
/** Reducere la deblocarea sezonului întreg (procent din suma episoadelor blocate). */
export const MOVIES_SEASON_DISCOUNT_PCT = intEnv("MOVIES_SEASON_DISCOUNT_PCT", 40, 0, 90);
/** Coloană legacy, neutilizată: valoare fixă scrisă doar pt. constrângerea NOT NULL a schemei DB vechi. */
export const MOVIES_DEFAULT_EPISODE_PRICE_UNITS = intEnv("MOVIES_DEFAULT_EPISODE_PRICE_UNITS", 500, 1, 1_000_000);
/** Preț per episod în RON (bani/cenți). Plată cu cardul (Stripe) — înlocuiește sistemul legacy de mai sus. */
export const MOVIES_EPISODE_PRICE_MIN_CENTS = intEnv("MOVIES_EPISODE_PRICE_MIN_CENTS", 100, 1, 10_000_000);
export const MOVIES_EPISODE_PRICE_MAX_CENTS = intEnv("MOVIES_EPISODE_PRICE_MAX_CENTS", 50_000, 1, 10_000_000);
export const MOVIES_DEFAULT_EPISODE_PRICE_CENTS = intEnv("MOVIES_DEFAULT_EPISODE_PRICE_CENTS", 500, 1, 10_000_000);
export const MOVIES_DEFAULT_FREE_EPISODES = intEnv("MOVIES_DEFAULT_FREE_EPISODES", 3, 0, 10);
export const MOVIES_MAX_FREE_EPISODES = 10;
export const MOVIES_MAX_EPISODE_DURATION_MS = intEnv("MOVIES_MAX_EPISODE_DURATION_MS", 180_000, 10_000, 3_600_000);
/** Cât e valid un token de stream pentru un episod blocat. */
export const MOVIES_STREAM_TOKEN_TTL_S = intEnv("MOVIES_STREAM_TOKEN_TTL_S", 600, 60, 3_600);
/**
 * Durata presupusă când nici episodul, nici videoul nu au `duration_ms`
 * (import încă neprocesat, video vechi) — ca un film lung să nu se oprească
 * la expirarea token-ului după `MOVIES_STREAM_TOKEN_TTL_S`.
 */
export const MOVIES_STREAM_FALLBACK_DURATION_S = intEnv("MOVIES_STREAM_FALLBACK_DURATION_S", 4 * 3_600, 600, 12 * 3_600);
export const MOVIES_CATALOG_PAGE_SIZE = 24;
