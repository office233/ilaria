export type ContentStatus = "draft" | "pending_review" | "published" | "archived";
export type ModerationStatus = "pending_review" | "approved" | "rejected";
export type MusicAudience = "general" | "kids";

export type MusicArtistRow = {
    user_id: string;
    stage_name: string;
    slug: string;
    bio: string;
    avatar_url: string | null;
    cover_url: string | null;
    approved_at: string;
    created_at: string;
    updated_at: string;
};

export type MusicAlbumRow = {
    id: string;
    artist_user_id: string;
    title: string;
    slug: string;
    cover_url: string | null;
    release_date: string | null;
    status: ContentStatus;
    price_units: number | null;
    /** Preț RON (cenți), plătit cu cardul (Stripe). `null` = „preț în curând". */
    price_cents: number | null;
    created_at: string;
    updated_at: string;
};

export type MusicTrackRow = {
    id: string;
    artist_user_id: string;
    album_id: string | null;
    track_number: number | null;
    title: string;
    slug: string;
    cover_url: string | null;
    genre: string;
    duration_ms: number;
    explicit: boolean;
    object_key: string;
    /** Doar piesele gratuite au URL public; cele premium se redau prin proxy cu token. */
    public_url: string | null;
    is_premium: boolean;
    price_units: number | null;
    /** Preț RON (cenți), plătit cu cardul (Stripe). `null` = „preț în curând". */
    price_cents: number | null;
    allow_reels: boolean;
    audio_track_id: number | null;
    audience: MusicAudience;
    status: ContentStatus;
    moderation_status: ModerationStatus;
    license_note: string | null;
    published_at: string | null;
    created_at: string;
    updated_at: string;
};

export type MusicViewer = {
    userId: string | null;
    isAdmin: boolean;
    unlockedTrackIds: ReadonlySet<string>;
    unlockedAlbumIds: ReadonlySet<string>;
};

export type ArtistDto = {
    id: string;
    slug: string;
    stageName: string;
    bio: string;
    avatarUrl: string | null;
    coverUrl: string | null;
    isOfficial: boolean;
};

export type TrackDto = {
    id: string;
    slug: string;
    title: string;
    coverUrl: string | null;
    genre: string;
    durationMs: number;
    explicit: boolean;
    isPremium: boolean;
    priceCents: number | null;
    locked: boolean;
    allowReels: boolean;
    audioTrackId: number | null;
    albumId: string | null;
    trackNumber: number | null;
    artist: ArtistDto;
    plays7d: number;
    liked: boolean;
    source?: "swypik" | "radio" | "audius" | "jamendo" | "podcast";
    streamUrl?: string;
    /** Alternative https pentru `streamUrl`, încercate în ordine de player dacă fluxul nu pornește. */
    streamUrlFallbacks?: string[];
    isLive?: boolean;
    /** Licența CC a pieselor externe (Jamendo) — atribuirea e obligatorie (CC BY / BY-SA). */
    licenseUrl?: string | null;
    /** Pagina piesei la sursă (link de atribuire). */
    externalUrl?: string | null;
};

export type AlbumDto = {
    id: string;
    slug: string;
    title: string;
    coverUrl: string | null;
    releaseDate: string | null;
    priceCents: number | null;
    locked: boolean;
    artist: ArtistDto;
    trackCount: number;
};

export type MusicUnlockStatus = "pending" | "paid" | "failed";
