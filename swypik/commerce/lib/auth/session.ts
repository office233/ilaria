/**
 * Unified session resolver — single source of truth for "who is the user".
 *
 * Reads the canonical `swypik_session` cookie set by `/api/auth verify_otp`
 * and returns a normalised `AuthSession` object containing the user id,
 * role (`shopper | creator | seller | admin`), and basic profile fields.
 *
 * - "seller" is derived: a `users` row whose lower(email) matches a row in
 *   `sellers` (status active/approved) is treated as role=seller, regardless
 *   of `users.role`. This lets us keep the existing `sellers` table without
 *   forcing every seller to also have role='seller' on `users`.
 * - "admin" comes from `users.role = 'admin'`.
 * - Legacy `creator_session` UUID cookies are honoured **only** when
 *   `NODE_ENV !== 'production'`, to preserve dev workflows.
 */

import crypto from "crypto";
import { cookies, headers } from "next/headers";
import { dbQuery } from "@/lib/db";

export const SESSION_COOKIE = "swypik_session";
export const LEGACY_CREATOR_COOKIE = "creator_session";

export type AuthRole = "shopper" | "creator" | "seller" | "admin";

export type AuthSession = {
  userId: string;
  role: AuthRole;
  email: string | null;
  displayName: string | null;
  username: string | null;
  /** Populated when role === "seller". */
  sellerId?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Un token de sesiune REAL e `crypto.randomBytes(32).toString("hex")` — exact
 * 64 de caractere hex. Orice altceva nu are voie să ajungă la `sha256()` și de
 * acolo într-o căutare de sesiune.
 *
 * DE CE EXISTĂ (audit 2026-08-25, breșă critică):
 * OTP-urile erau salvate în aceeași tabelă `user_sessions`, cu
 * `session_token_hash = sha256("otp:" + cod)`. Cum fiecare resolver hash-uia
 * valoarea BRUTĂ a cookie-ului, un cookie literal `swypik_session=otp:123456`
 * producea exact hash-ul rândului de OTP ⇒ autentificare completă pe contul
 * victimei, cu doar 10^6 încercări (și mult mai puține, fiindcă interogarea nu
 * lega hash-ul de email: se potrivea ORICE OTP activ din sistem).
 *
 * Verificarea de format singură închide vectorul, indiferent de ce filtre mai
 * există în interogări. E prima linie, nu singura — vezi și filtrul de tip din
 * interogări și revocarea OTP-urilor la emitere.
 */
export function isSessionTokenFormat(token: string | null | undefined): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

type UserRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  username: string | null;
  role: string | null;
  email_verified_at: string | null;
};

async function loadUserBySessionToken(sessionToken: string): Promise<UserRow | null> {
  // Garda de format: doar token-uri de sesiune reale ajung la hash (vezi
  // isSessionTokenFormat). Fara ea, un cookie `otp:NNNNNN` se potrivea cu
  // randul de OTP din aceeasi tabela.
  if (!isSessionTokenFormat(sessionToken)) return null;
  try {
    const { rows } = await dbQuery<UserRow>(
      `SELECT us.user_id,
              u.email,
              u.display_name,
              u.username,
              u.role,
              u.email_verified_at
       FROM user_sessions us
       JOIN users u ON u.id = us.user_id
       WHERE us.session_token_hash = $1
         AND us.expires_at > now()
         AND us.revoked_at IS NULL
         AND COALESCE(us.metadata->>'type', 'session') = 'session'
         -- Conturile suspendate/banate/sterse nu mai pot actiona nici cu o
         -- sesiune inca valida (defense-in-depth pe langa revocarea sesiunilor
         -- din fluxul de suspendare admin — vezi BUG-hunt 2026-08-04).
         AND COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')
         AND (u.suspended_until IS NULL OR u.suspended_until <= now())
       LIMIT 1`,
      [hashSessionToken(sessionToken)],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function loadUserById(userId: string): Promise<UserRow | null> {
  try {
    const { rows } = await dbQuery<UserRow>(
      `SELECT id AS user_id, email, display_name, username, role, email_verified_at
       FROM users
       WHERE id = $1
         AND COALESCE(status, 'active') NOT IN ('suspended', 'banned', 'deleted')
         AND (suspended_until IS NULL OR suspended_until <= now())
       LIMIT 1`,
      [userId],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function findSellerByEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  try {
    const { rows } = await dbQuery<{ id: string }>(
      `SELECT id FROM sellers
       WHERE lower(email) = lower($1)
         AND status IN ('active', 'approved')
       LIMIT 1`,
      [email],
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

function normaliseUserRole(raw: string | null | undefined): AuthRole {
  switch ((raw || "").toLowerCase()) {
    case "admin":
      return "admin";
    case "creator":
      return "creator";
    case "seller":
      return "seller";
    default:
      return "shopper";
  }
}

async function buildSession(user: UserRow): Promise<AuthSession> {
  const baseRole = normaliseUserRole(user.role);
  let role: AuthRole = baseRole;
  let sellerId: string | null = null;

  // Admin keeps admin. Otherwise, a matching seller row promotes role to "seller"
  // — DOAR daca emailul e verificat (audit 2026-08-25): altfel un cont creat cu
  // parola pe emailul public al unui seller aprobat capata rol de seller la
  // fiecare cerere, fara sa detina emailul.
  if (baseRole !== "admin" && user.email_verified_at) {
    const matchedSellerId = await findSellerByEmail(user.email);
    if (matchedSellerId) {
      role = "seller";
      sellerId = matchedSellerId;
    }
  }

  return {
    userId: user.user_id,
    role,
    email: user.email,
    displayName: user.display_name,
    username: user.username,
    sellerId,
  };
}

/** Returns the resolved session, or `null` when the visitor is anonymous. */
export async function getAuthSession(): Promise<AuthSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    const user = await loadUserBySessionToken(token);
    if (user) return buildSession(user);
  }

  // PWA / mobile clients: Authorization: Bearer <opaque token>.
  // Same user_sessions table (kind='bearer'), checked AFTER the cookie so
  // every existing cookie-based flow stays untouched. The admin
  // `Bearer <ADMIN_SECRET>` flow lives in lib/auth/getAuthUser.ts and is
  // unaffected: an ADMIN_SECRET will simply not match any session hash here.
  const bearer = await getBearerToken();
  if (bearer) {
    const user = await loadUserBySessionToken(bearer);
    if (user) return buildSession(user);
  }

  if (process.env.NODE_ENV !== "production") {
    const legacy = store.get(LEGACY_CREATOR_COOKIE)?.value;
    if (legacy && UUID_RE.test(legacy)) {
      const user = await loadUserById(legacy);
      if (user) return buildSession(user);
    }
  }

  return null;
}

/** Extract a Bearer token from the incoming request headers (or null). */
async function getBearerToken(): Promise<string | null> {
  try {
    const h = await headers();
    const auth = h.get("authorization") || h.get("Authorization");
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
    const token = auth.slice(7).trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

/** Convenience: throws if not signed in, returns the session otherwise. */
export async function requireAuthSession(): Promise<AuthSession> {
  const session = await getAuthSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

/** Map a role to its preferred landing page after login. */
export function defaultLandingForRole(role: AuthRole): string {
  switch (role) {
    case "admin":
      return "/admin";
    case "seller":
      return "/seller";
    case "creator":
      return "/account";
    default:
      return "/account";
  }
}

/**
 * Decide where to send a freshly-authenticated user.
 * - Honours an explicit `next` param when present and safe (relative URL).
 * - Otherwise falls back to the role's natural landing page.
 */
export function resolvePostLoginRedirect(role: AuthRole, next?: string | null): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return next;
  }
  return defaultLandingForRole(role);
}
