import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import {
    MOVIES_CREATOR_SHARE_BPS,
    MOVIES_EPISODE_PRICE_MAX_CENTS,
    MOVIES_EPISODE_PRICE_MIN_CENTS,
    MOVIES_SEASON_DISCOUNT_PCT,
} from "./config";
import { lockedEpisodeCount } from "./access";
import type { MovieSeriesRow } from "./types";

/**
 * Prețul sezonului în RON (cenți): suma episoadelor blocate cu discount-ul de
 * sezon, sau `null` dacă serialul încă nu are un preț RON setat de creator
 * ("preț în curând" — vezi migrarea 20260925_0009_card_unlocks).
 */
export function seasonPriceCents(
    series: Pick<MovieSeriesRow, "free_episodes" | "episode_price_cents">,
    totalEpisodes: number,
    discountPct: number = MOVIES_SEASON_DISCOUNT_PCT,
): number | null {
    if (series.episode_price_cents === null) return null;
    const locked = lockedEpisodeCount(series, totalEpisodes);
    if (locked === 0) return 0;
    return Math.round(locked * series.episode_price_cents * (1 - discountPct / 100));
}

/**
 * Cota creatorului dintr-o deblocare, în cenți RON. Zero când serialul e al
 * contului oficial (platforma nu se plătește pe sine) și când viewer-ul e
 * chiar owner-ul. Plătit prin Stripe, creditat pe `lib/wallet/ledger.ts`
 * (nu mai trece prin sistemul legacy de recompense).
 */
export function creatorShareCents(
    amountCents: number,
    ownerUserId: string,
    viewerUserId: string,
    shareBps: number = MOVIES_CREATOR_SHARE_BPS,
): number {
    if (amountCents <= 0) return 0;
    if (ownerUserId === SWYPIK_OFFICIAL_ID || ownerUserId === viewerUserId) return 0;
    return Math.floor((amountCents * shareBps) / 10_000);
}

export function clampEpisodePriceCents(cents: number): number {
    const n = Math.trunc(Number(cents) || 0);
    return Math.min(MOVIES_EPISODE_PRICE_MAX_CENTS, Math.max(MOVIES_EPISODE_PRICE_MIN_CENTS, n));
}
