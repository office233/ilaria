/**
 * Rate pentru engagement sintetic (fallback când produsul nu are
 * likes/comments reale) — unica sursă de adevăr pentru ProductFeed
 * (client) și /api/v1/feed (server).
 */
export const SYNTHETIC_LIKES_PER_ORDER = 0.35;
export const SYNTHETIC_COMMENTS_PER_ORDER = 0.04;
export const SYNTHETIC_DEFAULT_ORDERS_LIKES = 40;
export const SYNTHETIC_DEFAULT_ORDERS_COMMENTS = 10;
