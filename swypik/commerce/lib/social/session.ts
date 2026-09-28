import crypto from "crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { isSessionTokenFormat } from "@/lib/auth/session";
import { rateLimit, getClientIPFromHeaders } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";

export const ANON_SESSION_COOKIE = "anon_session";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export type SocialUserSession = {
  userId: string;
  /** true = shell anonim (fără cont real). */
  isAnon?: boolean;
  anonSessionId?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined | null): value is string {
  return Boolean(value && UUID_RE.test(value));
}

function usernameFromSeed(prefix: string, seed: string): string {
  const compact = seed.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
  return `${prefix}_${compact || crypto.randomBytes(4).toString("hex")}`;
}

// ---------- HMAC-signed anon cookie (UUID.hmac) ----------

/** Cheia HMAC pentru token-urile de identitate anonimă (anon_session, feed_sid). */
export function getAnonSigningKey(): string {
  const key = process.env.APP_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || "";
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY missing — refusing to sign anon sessions with fallback key in production");
    }
    // Last-resort dev fallback. Production MUST set APP_ENCRYPTION_KEY.
    return "swypik-dev-anon-fallback-key";
  }
  return key;
}

function anonHmac(uuid: string): string {
  return crypto
    .createHmac("sha256", getAnonSigningKey())
    .update(uuid)
    .digest("hex")
    .slice(0, 32); // 16 bytes hex
}

export function signAnonValue(uuid: string): string {
  return `${uuid}.${anonHmac(uuid)}`;
}

/**
 * Parse anon cookie. Returns the UUID iff the HMAC is valid.
 * Legacy plain-UUID cookies are rejected to prevent impersonation.
 */
function parseSignedAnon(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 0) {
    // Legacy plain UUID — REJECT (security: no impersonation).
    return null;
  }
  const uuid = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!isUuid(uuid) || mac.length !== 32) return null;
  const expected = anonHmac(uuid);
  try {
    const a = Buffer.from(mac, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return uuid;
}

/** Cât de rar rescriem `last_seen_at` pentru aceeași sesiune (vezi mai jos). */
const LAST_SEEN_REFRESH = "15 minutes";

async function ensureUuidUser(userId: string, source: string): Promise<string> {
  const username = usernameFromSeed(source, userId);
  // 2026-08-24 (audit perf): această funcție rulează la FIECARE cerere a unui
  // vizitator anonim, inclusiv la fiecare pagină de feed. Un UPDATE
  // necondiționat însemna, pe cea mai fierbinte cale de citire din aplicație, o
  // tuplă moartă + WAL + actualizarea indexurilor de fiecare dată. Acum
  // rescriem doar dacă marcajul chiar e vechi; când nu se face UPDATE,
  // `RETURNING` nu întoarce nimic, dar conflictul e chiar pe `id`, deci rândul
  // există și id-ul cerut e cel corect.
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO users (id, external_auth_id, username, display_name, locale, role, metadata, last_seen_at)
     VALUES ($1, $2, $3, $4, 'ro', 'shopper', $5::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET last_seen_at = NOW()
       WHERE users.last_seen_at IS NULL
          OR users.last_seen_at < NOW() - INTERVAL '${LAST_SEEN_REFRESH}'
     RETURNING id`,
    [
      userId,
      `${source}:${userId}`,
      username,
      source === "anon" ? "Guest" : "Creator",
      JSON.stringify({ source: `${source}_session` }),
    ],
  );

  return rows[0]?.id ?? userId;
}

async function resolveUserSession(sessionToken: string): Promise<string | null> {
  if (!isSessionTokenFormat(sessionToken)) return null;
  try {
    // New path: hashed token lookup in user_sessions (from new auth flow)
    const tokenHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT user_id FROM user_sessions
       WHERE session_token_hash = $1
         AND COALESCE(metadata->>'type', 'session') = 'session'
         AND expires_at > NOW()
         AND revoked_at IS NULL
         AND user_id IN (
           SELECT id FROM users
           WHERE COALESCE(status, 'active') NOT IN ('suspended', 'banned', 'deleted')
             AND (suspended_until IS NULL OR suspended_until <= NOW())
         )
       LIMIT 1`,
      [tokenHash],
    );
    if (rows.length > 0) return rows[0].user_id;
  } catch {
    // table might not exist yet in some envs — fall through
  }
  return null;
}

/**
 * Verify that a UUID corresponds to a real anon user (no password set, role=shopper).
 * Used for backward-compat with legacy plain-UUID swypik_session cookies — we now
 * require the DB row to be a true anon shell, otherwise an attacker could
 * impersonate any user by guessing/leaking their UUID.
 */
async function isAnonUser(userId: string): Promise<boolean> {
  try {
    const { rows } = await dbQuery<{ id: string }>(
      `SELECT id FROM users
       WHERE id = $1
         AND password_hash IS NULL
         AND email IS NULL
         AND (metadata->>'source') IN ('anon_session','shopper_session')
       LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export type SocialIdentity = {
  userId: string;
  /** true = shell anonim (cookie `anon_session` / legacy), fără cont real. */
  isAnon: boolean;
};

async function resolveExistingSocialUser(cookieStore: CookieStore): Promise<SocialIdentity | null> {
  const shopperSession = cookieStore.get("swypik_session")?.value;
  if (shopperSession) {
    // 1) New hashed-token user_sessions (canonical authenticated path)
    const userSessionId = await resolveUserSession(shopperSession);
    if (userSessionId) return { userId: userSessionId, isAnon: false };

    // 3) Legacy plain-UUID cookie: ONLY accept if the DB row is a real anon shell.
    //    Otherwise refuse — forces re-login and blocks UUID impersonation.
    if (isUuid(shopperSession) && (await isAnonUser(shopperSession))) {
      return { userId: await ensureUuidUser(shopperSession, "shopper"), isAnon: true };
    }
  }

  const creatorSession = cookieStore.get("creator_session")?.value;
  if (process.env.NODE_ENV !== "production" && isUuid(creatorSession)) {
    return { userId: await ensureUuidUser(creatorSession, "creator"), isAnon: false };
  }

  const rawAnon = cookieStore.get(ANON_SESSION_COOKIE)?.value;
  const verifiedAnon = parseSignedAnon(rawAnon);
  if (verifiedAnon) return { userId: await ensureUuidUser(verifiedAnon, "anon"), isAnon: true };

  return null;
}

/** Identitatea socială curentă (cont real sau shell anonim semnat), fără a crea nimic. */
export async function getSocialIdentity(): Promise<SocialIdentity | null> {
  const cookieStore = await cookies();
  return resolveExistingSocialUser(cookieStore);
}

/**
 * Id-ul unui cont REAL (sesiune autentificată). Shell-urile anonime întorc null.
 * Folosit acolo unde un cont e obligatoriu (DM, apeluri, XP gaming, rapoarte).
 */
export async function getAccountUserId(): Promise<string | null> {
  const identity = await getSocialIdentity();
  return identity && !identity.isAnon ? identity.userId : null;
}

export async function getOptionalSocialUserId(): Promise<string | null> {
  const identity = await getSocialIdentity();
  return identity?.userId ?? null;
}

/**
 * Id-ul user-ului anonim (shell) din cookie-ul `anon_session`, dacă există și
 * e valid criptografic + confirmat ca shell anonim în DB. Folosit la login
 * pentru migrarea activității anonime (like-uri, salvări, follow-uri) către
 * contul real — fără asta, tot ce a apreciat vizitatorul dispărea la
 * autentificare (audit 2026-08-25).
 */
export async function getAnonShellUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const verified = parseSignedAnon(cookieStore.get(ANON_SESSION_COOKIE)?.value);
  if (!verified) return null;
  return (await isAnonUser(verified)) ? verified : null;
}

/** Eroare la crearea unei identități anonime (limită per IP / cookie imposibil de setat). */
export class AnonSessionError extends Error {
  constructor(
    readonly status: 403 | 429,
    readonly code: "anon_rate_limited" | "anon_cookie_unavailable",
  ) {
    super(code);
    this.name = "AnonSessionError";
  }
}

/** Mapează AnonSessionError la un răspuns HTTP; null pentru alte erori. */
export function anonSessionErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof AnonSessionError)) return null;
  return NextResponse.json({ error: err.code }, { status: err.status });
}

const ANON_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

/**
 * Identitatea socială curentă sau, dacă lipsește, un shell anonim nou.
 *
 * 2026-09-26 (audit abuz): un shell nou se creează DOAR dacă cookie-ul semnat
 * poate fi scris pe răspuns (Route Handler / Server Action) — altfel fiecare
 * cerere fără cookie crea un rând `users` nou (gaming, DM). În plus, emiterea
 * e limitată per IP ca rotirea cookie-ului să nu umfle contoarele.
 */
export async function getOrCreateSocialUser(): Promise<SocialUserSession> {
  const cookieStore = await cookies();
  const existing = await resolveExistingSocialUser(cookieStore);
  if (existing) return { userId: existing.userId, isAnon: existing.isAnon };

  const ip = getClientIPFromHeaders(await headers());
  const mint = await rateLimit("anon_mint", ip, ABUSE_LIMITS.anonMint);
  if (!mint.success) throw new AnonSessionError(429, "anon_rate_limited");

  const anonSessionId = crypto.randomUUID();
  try {
    cookieStore.set(ANON_SESSION_COOKIE, signAnonValue(anonSessionId), ANON_COOKIE_OPTIONS);
  } catch {
    throw new AnonSessionError(403, "anon_cookie_unavailable");
  }
  const userId = await ensureUuidUser(anonSessionId, "anon");
  return { userId, anonSessionId, isAnon: true };
}

export function setAnonSessionCookie(response: Response, anonSessionId?: string): void {
  if (!anonSessionId || !("cookies" in response)) return;

  const nextResponse = response as Response & {
    cookies?: { set: (name: string, value: string, options: Record<string, unknown>) => void };
  };

  // Store signed value: <uuid>.<hmac> — prevents impersonation if cookie is leaked/guessed.
  nextResponse.cookies?.set(ANON_SESSION_COOKIE, signAnonValue(anonSessionId), ANON_COOKIE_OPTIONS);
}
