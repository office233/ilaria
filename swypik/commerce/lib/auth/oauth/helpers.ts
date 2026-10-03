/**
 * Shared helpers for OAuth (Google / Apple) flows.
 *
 * - issueOAuthSession: create user_sessions row + return Set-Cookie header
 * - findOrCreateUserFromOAuth: link existing user or create new one
 */
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { hashSessionToken } from "@/lib/auth/session";
import { APP_URL } from "@/lib/app-url";
import { logger } from "@/lib/logger";

const COOKIE_NAME = "swypik_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const isProd = process.env.NODE_ENV === "production";
const SECURE_FLAG = isProd ? "; Secure" : "";

export type OAuthProvider = "google" | "apple";

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateUsername(email: string | null, fallback: string): string {
  const base = (email ? email.split("@")[0] : fallback)
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12)
    .toLowerCase();
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base || "user"}_${suffix}`;
}

export type OAuthProfile = {
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

export type OAuthSignupContext = {
  ip?: string | null;
  ipCountry?: string | null;
  userAgent?: string | null;
};

export async function findOrCreateUserFromOAuth(
  profile: OAuthProfile,
  signupContext?: OAuthSignupContext,
): Promise<{ userId: string; recreationBlocked?: boolean }> {
  // 1) already linked?
  const linked = await dbQuery<{ user_id: string }>(
    `SELECT user_id FROM oauth_accounts
     WHERE provider = $1 AND provider_user_id = $2
     LIMIT 1`,
    [profile.provider, profile.providerUserId],
  );
  if (linked.rows[0]) return { userId: linked.rows[0].user_id };

  // A provider subject is proof of that provider account, not of an
  // unverified email address. Do not link or reserve someone else's email.
  if (!profile.emailVerified) profile = { ...profile, email: null };

  // 2) find user by verified email
  let userId: string | null = null;
  let recreationBlocked = false;
  if (profile.email) {
    const existing = await dbQuery<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [profile.email],
    );
    if (existing.rows[0]) userId = existing.rows[0].id;
  }

  // 3) else create user
  if (!userId) {
    const username = generateUsername(profile.email, profile.providerUserId);
    const displayName =
      profile.displayName ||
      (profile.email ? profile.email.split("@")[0] : username);
    const created = await dbQuery<{ id: string }>(
      `INSERT INTO users (
         username, email, display_name, avatar_url, locale, role, status, metadata, auth_providers,
         email_verified_at
       )
       VALUES ($1, $2, $3, $4, 'ro', 'creator', 'active', '{}', ARRAY[$5]::text[],
               CASE WHEN $6::boolean THEN now() ELSE NULL END)
       RETURNING id`,
      [
        username,
        profile.email,
        displayName,
        profile.avatarUrl,
        `oauth_${profile.provider}`,
        profile.emailVerified,
      ],
    );
    userId = created.rows[0].id;
    // M1.3 referral attribution — best-effort, never blocks signup
    try {
      const { attributeOnSignup } = await import("@/lib/referral/attribution");
      await attributeOnSignup({ inviteeUserId: userId });
    } catch (err) {
      logger.warn({ err }, "[oauth/signup] referral attribution failed");
    }
    // Fraud recreation detection — best-effort, never blocks signup
    try {
      const { checkRecreationAndMaybeBlock } = await import("@/lib/risk/recreation-detection");
      const r = await checkRecreationAndMaybeBlock({
        userId,
        email: profile.email,
        ip: signupContext?.ip || null,
        ipCountry: signupContext?.ipCountry || null,
        userAgent: signupContext?.userAgent || null,
        signupPath: "oauth",
      });
      recreationBlocked = r.blocked;
    } catch (err) {
      logger.warn({ err }, "[oauth/signup] recreation check failed");
    }
  } else if (profile.email && profile.emailVerified) {
    // backfill verification on existing email
    await dbQuery(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now())
       WHERE id = $1`,
      [userId],
    );
  }

  // 4) link provider
  await dbQuery(
    `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_user_id) DO NOTHING`,
    [userId, profile.provider, profile.providerUserId, profile.email],
  );

  return { userId, recreationBlocked };
}

export async function issueOAuthSessionCookie(userId: string): Promise<string> {
  const sessionToken = generateToken();
  const sessionHash = hashSessionToken(sessionToken);
  await dbQuery(
    `INSERT INTO user_sessions (user_id, session_token_hash, expires_at, metadata)
     VALUES ($1, $2, now() + interval '30 days', $3::jsonb)`,
    [userId, sessionHash, JSON.stringify({ type: "session", oauth: true })],
  );
  await dbQuery(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);
  return `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${SECURE_FLAG}`;
}

export const OAUTH_STATE_COOKIE = "swypik_oauth_state";
export const OAUTH_NEXT_COOKIE = "swypik_oauth_next";

export function buildStateCookie(state: string, provider: OAuthProvider): string {
  return `${OAUTH_STATE_COOKIE}=${provider}.${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${SECURE_FLAG}`;
}

export function clearStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE_FLAG}`;
}

export function getOAuthRedirectBase(): string {
  const v = process.env.OAUTH_REDIRECT_BASE;
  if (v) return v;
  // In any environment, prefer APP_URL (config-driven)
  return APP_URL;
}

export function isSafeRedirect(next: string | null | undefined): string {
  if (!next) return '/';
  // reject protocol-relative URLs (//evil.com)
  if (next.startsWith('//') || next.startsWith('\\')) return '/';
  // require relative path starting with single /
  if (!next.startsWith('/')) return '/';
  // reject embedded protocol (e.g. /javascript:alert)
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(next)) return '/';
  return next;
}
