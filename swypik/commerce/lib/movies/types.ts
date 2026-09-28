import type { LicenseType, PublicAttribution, TitleFormat } from "./license";

export type SeriesStatus = "draft" | "pending_review" | "published" | "archived";
export type EpisodeStatus = "draft" | "published";

export type MovieSeriesRow = {
    id: string;
    slug: string;
    owner_user_id: string;
    title: string;
    synopsis: string;
    genres: string[];
    language_code: string;
    cover_url: string | null;
    poster_url: string | null;
    trailer_video_id: string | null;
    status: SeriesStatus;
    free_episodes: number;
    /** bigint în DB; pg îl întoarce ca string — normalizat la number în repository. */
    episode_price_units: number;
    /** Preț RON (cenți) per episod, plătit cu cardul (Stripe). `null` = creatorul nu a setat încă un preț — conținutul afișează „preț în curând". */
    episode_price_cents: number | null;
    is_adult: boolean;
    license_note: string | null;
    /** Metadate de licență (migrarea 20260926_0040) — obligatorii la publicare, vezi lib/movies/license.ts. */
    format: TitleFormat;
    license_type: LicenseType | null;
    attribution_text: string | null;
    license_source_url: string | null;
    license_territories: string[];
    license_expires_at: string | null;
    published_at: string | null;
    created_at: string;
    updated_at: string;
};

/** Rând de episod + miniatura clipului (JOIN videos). */
export type MovieEpisodeWithThumb = MovieEpisodeRow & { thumbnail_url: string | null };

export type MovieEpisodeRow = {
    id: string;
    series_id: string;
    episode_number: number;
    video_id: string;
    title: string;
    duration_ms: number | null;
    status: EpisodeStatus;
    created_at: string;
    updated_at: string;
};

export type MovieUnlockStatus = "pending" | "paid" | "failed";

export type MovieUnlockRow = {
    id: string;
    user_id: string;
    series_id: string;
    episode_id: string | null;
    units_paid: number;
    creator_share_units: number;
    ledger_ref: string | null;
    created_at: string;
    /** Stripe PaymentIntent id — plata cu cardul care a deblocat acest rând. */
    payment_intent_id: string | null;
    amount_cents: number | null;
    currency: string;
    status: MovieUnlockStatus;
};

export type MovieProgressRow = {
    user_id: string;
    episode_id: string;
    position_ms: number;
    completed: boolean;
    updated_at: string;
};

/** Ce știe serverul despre viewer când calculează accesul. */
export type ViewerContext = {
    userId: string | null;
    isAdmin: boolean;
    unlockedEpisodeIds: ReadonlySet<string>;
    hasSeasonUnlock: boolean;
};

/** DTO public pentru un episod în pagina serialului / player. */
export type EpisodeDto = {
    id: string;
    number: number;
    title: string;
    durationMs: number | null;
    thumbnailUrl: string | null;
    locked: boolean;
    /** Preț RON (cenți); `null` = „preț în curând" (creatorul nu l-a setat încă). */
    priceCents: number | null;
    progress: { positionMs: number; completed: boolean } | null;
};

export type SeriesDto = {
    id: string;
    slug: string;
    title: string;
    synopsis: string;
    genres: string[];
    coverUrl: string | null;
    posterUrl: string | null;
    trailerVideoId: string | null;
    freeEpisodes: number;
    /** Preț RON (cenți); `null` = „preț în curând". */
    episodePriceCents: number | null;
    seasonPriceCents: number | null;
    /** Procentul aplicat la sezon, calculat pe server (clientul nu vede env-ul). */
    seasonDiscountPct: number;
    isAdult: boolean;
    episodeCount: number;
    owner: { id: string; name: string; isOfficial: boolean };
    format: TitleFormat;
    /** Atribuirea cerută de licență (CC BY etc.), afișată pe pagina titlului. */
    attribution: PublicAttribution | null;
};
