/**
 * Profilul public (/u/<username> + GET /api/users/profile/<username>).
 * Statisticile vin din modulul unic `profile/stats`, grilele din `profile/videos`.
 */
import { dbQuery } from "@/lib/db";
import { getCreatorBadges, type CreatorBadges } from "@/lib/social/creator-badges";
import { getBlockState } from "./blocks";
import {
  buildCreatorLinks,
  emptyToNull,
  mapPromotedProductRow,
  type CreatorLink,
  type PromotedProduct,
  type PromotedProductRow,
} from "./profile/format";
import { getProfileStats, type ProfileStats } from "./profile/stats";

export type { CreatorLink, PromotedProduct } from "./profile/format";

export type UserProfileQuery = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
) => Promise<{ rows: T[]; rowCount: number }>;

export type PublicUserProfile = {
  profile: {
    id: string;
    username: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
    isVerified: boolean;
    isFollowing: boolean;
    isOwnProfile: boolean;
    links: CreatorLink[];
    categories: string[];
    /** Tab-ul „Apreciate" e vizibil public. */
    likedVideosPublic: boolean;
    /** Viewerul l-a blocat pe acest utilizator. */
    blockedByViewer: boolean;
    /** Acest utilizator l-a blocat pe viewer — profilul se afișează restrâns. */
    blocksViewer: boolean;
  };
  stats: ProfileStats;
  badges: CreatorBadges;
  promotedProducts: PromotedProduct[];
};

type GetPublicUserProfileOptions = {
  viewerUserId?: string | null;
  query?: UserProfileQuery;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_verified: boolean | null;
  liked_videos_public: boolean | null;
  is_following: boolean | null;
  website_url: string | null;
  social_links: Record<string, unknown> | null;
};

const USERNAME_PATTERN = /^[a-z0-9._-]{1,40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeProfileUsername(value: unknown) {
  const username = String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();

  return USERNAME_PATTERN.test(username) ? username : null;
}

export function normalizeViewerUserId(value: unknown) {
  const id = String(value ?? "").trim();
  return UUID_PATTERN.test(id) ? id : null;
}

export async function getPublicUserProfile(
  usernameParam: string,
  options: GetPublicUserProfileOptions = {}
): Promise<PublicUserProfile | null> {
  const username = normalizeProfileUsername(usernameParam);
  if (!username) return null;

  const query = options.query || dbQuery;
  const viewerUserId = normalizeViewerUserId(options.viewerUserId);

  const { rows } = await query<ProfileRow>(
    `SELECT
       u.id,
       u.username,
       COALESCE(NULLIF(u.display_name, ''), NULLIF(cp.display_name, ''), u.username) AS display_name,
       COALESCE(NULLIF(u.avatar_url, ''), NULLIF(cp.avatar_url, '')) AS avatar_url,
       COALESCE(NULLIF(u.bio, ''), NULLIF(cp.bio, '')) AS bio,
       COALESCE(u.is_verified, cp.verification_status = 'verified', false) AS is_verified,
       u.liked_videos_public,
       cp.website_url,
       cp.social_links,
       CASE
         WHEN $2::uuid IS NULL OR $2::uuid = u.id THEN false
         ELSE EXISTS (
           SELECT 1 FROM follows f WHERE f.follower_user_id = $2::uuid AND f.following_user_id = u.id
         )
       END AS is_following
     FROM users u
     LEFT JOIN creator_profiles cp ON cp.user_id = u.id
     WHERE lower(u.username) = $1
       AND u.status = 'active'
     LIMIT 1`,
    [username, viewerUserId]
  );

  const row = rows[0];
  if (!row) return null;

  const [stats, { rows: productRows }, { rows: interestRows }, badges, block] = await Promise.all([
    getProfileStats(row.id, query),
    query<PromotedProductRow>(
      `SELECT DISTINCT ON (p.id)
         p.id, p.title, p.image_url, p.price_cents, p.currency, p.product_url
       FROM creator_product_links cpl
       JOIN marketplace_products p ON p.id = cpl.product_id
       WHERE cpl.creator_id = $1
         AND cpl.status = 'active'
         AND p.status = 'active'
       ORDER BY p.id, cpl.created_at DESC
       LIMIT 12`,
      [row.id]
    ),
    query<{ topic: string }>(
      `SELECT topic FROM user_interests WHERE user_id = $1 ORDER BY weight DESC, topic ASC LIMIT 8`,
      [row.id]
    ),
    getCreatorBadges(row.id, { verified: Boolean(row.is_verified), query }),
    getBlockState(viewerUserId, row.id),
  ]);

  const isOwnProfile = viewerUserId === row.id;
  const handleName = row.username || username;

  return {
    profile: {
      id: row.id,
      username: handleName,
      handle: `@${handleName}`,
      displayName: row.display_name || handleName,
      avatarUrl: emptyToNull(row.avatar_url),
      bio: emptyToNull(row.bio),
      isVerified: Boolean(row.is_verified),
      isFollowing: isOwnProfile ? false : Boolean(row.is_following),
      isOwnProfile,
      links: buildCreatorLinks(row.website_url, row.social_links),
      categories: interestRows.map((r) => String(r.topic || "").trim()).filter((t) => t.length > 0),
      likedVideosPublic: Boolean(row.liked_videos_public),
      blockedByViewer: block.blockedByMe,
      blocksViewer: block.blocksMe,
    },
    stats,
    badges,
    promotedProducts: productRows.map(mapPromotedProductRow),
  };
}
