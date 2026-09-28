/**
 * Autentificarea consolei de admin — sesiuni PER ADMINISTRATOR.
 *
 * Oamenii intră cu contul lor Swypik (login OTP normal): dacă users.role =
 * 'admin', /api/auth emite și cookie-ul `admin_token`, legat de user_id.
 * Sesiunea e validă doar cât timp contul e încă admin și nesuspendat — o
 * retrogradare sau suspendare o invalidează imediat, fără alt pas.
 *
 * `ADMIN_SECRET` NU mai e o parolă pentru oameni. Rămâne pentru:
 *   - mașini (scripturi/cron): `Authorization: Bearer <ADMIN_SECRET>` →
 *     actor `machine` (tot în afară de acordarea rolurilor de admin);
 *   - acces de urgență („break glass”), doar cu ADMIN_BREAK_GLASS_ENABLED=1:
 *     secret + emailul unui admin existent → sesiune legată de acel admin.
 */
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { dbQuery } from "@/lib/db";
import { normalizeAdminRole, type AdminRole } from "@/lib/admin/permissions";

const COOKIE_NAME = "admin_token";
const DEFAULT_SESSION_TTL_HOURS = 12;

export type AdminSessionKind = "otp" | "break_glass";

export type AdminActor = {
  kind: "admin_user" | "break_glass" | "machine";
  userId: string | null;
  email: string | null;
  username: string | null;
  role: AdminRole | "machine";
  /** sha256 al token-ului de sesiune (cheia din admin_sessions); null pentru mașini. */
  sessionHash: string | null;
};

function sessionTtlHours(): number {
  const n = Number(process.env.ADMIN_SESSION_TTL_HOURS);
  return Number.isFinite(n) && n > 0 && n <= 24 * 7 ? n : DEFAULT_SESSION_TTL_HOURS;
}

function secureSecretCompare(candidate: string | null | undefined, expected: string | null): boolean {
  if (!candidate || !expected) return false;
  try {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function hashAdminSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getAdminSecret(): string | null {
  const v = process.env.ADMIN_SECRET?.trim();
  return v ? v : null;
}

/** Secretul mașinilor (Bearer). Nu autentifică oameni. */
export function isAdminToken(token: string | null | undefined): boolean {
  return secureSecretCompare(token, getAdminSecret());
}

/** Login de urgență cu ADMIN_SECRET — dezactivat implicit. */
export function isBreakGlassEnabled(): boolean {
  return process.env.ADMIN_BREAK_GLASS_ENABLED === "1" && getAdminSecret() !== null;
}

export function getAdminCookieName(): string {
  return COOKIE_NAME;
}

export function readAdminTokenFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(";")) {
    const [name, ...rest] = segment.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

type SessionRow = {
  token: string;
  kind: string;
  user_id: string;
  email: string | null;
  username: string | null;
  admin_role: string | null;
};

/** Sesiune validă = neexpirată, nerevocată, cont încă admin și nesuspendat. */
export async function resolveAdminSessionToken(token: string): Promise<AdminActor | null> {
  if (!token) return null;
  const { rows } = await dbQuery<SessionRow>(
    `SELECT s.token, s.kind, u.id::text AS user_id, u.email, u.username, u.admin_role
       FROM admin_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1
        AND s.expires_at > now()
        AND s.revoked_at IS NULL
        AND u.role = 'admin'
        AND (u.suspended_until IS NULL OR u.suspended_until <= now())
      LIMIT 1`,
    [hashAdminSessionToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind === "break_glass" ? "break_glass" : "admin_user",
    userId: row.user_id,
    email: row.email,
    username: row.username,
    role: normalizeAdminRole(row.admin_role),
    sessionHash: row.token,
  };
}

const MACHINE_ACTOR: AdminActor = {
  kind: "machine",
  userId: null,
  email: null,
  username: null,
  role: "machine",
  sessionHash: null,
};

/** Actorul unei cereri API: Bearer (mașină) sau cookie de sesiune. */
export async function getAdminActorFromRequest(req: Request): Promise<AdminActor | null> {
  if (isAdminToken(bearerFrom(req))) return MACHINE_ACTOR;
  const token = readAdminTokenFromCookieHeader(req.headers.get("cookie"));
  if (!token) return null;
  return resolveAdminSessionToken(token).catch(() => null);
}

/** Actorul din cookie-urile cererii curente (server components, server actions). */
export async function getAdminActor(): Promise<AdminActor | null> {
  try {
    const store = await cookies();
    const token = store.get(COOKIE_NAME)?.value;
    return token ? await resolveAdminSessionToken(token) : null;
  } catch {
    return null;
  }
}

export async function isAdminRequest(req: Request): Promise<boolean> {
  return (await getAdminActorFromRequest(req)) !== null;
}

export async function hasAdminSession(): Promise<boolean> {
  return (await getAdminActor()) !== null;
}

export async function requireAdminSession(redirectTo = "/admin"): Promise<void> {
  if (!(await hasAdminSession())) redirect(redirectTo);
}

export async function assertAdminSession(): Promise<void> {
  if (!(await hasAdminSession())) throw new Error("Unauthorized");
}

function cookieFlags(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

/** Creează o sesiune de admin pentru `userId` și întoarce header-ul Set-Cookie. */
export async function createAdminSessionAndGetCookie(opts: {
  userId: string;
  kind?: AdminSessionKind;
  req?: Request;
}): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const ttl = sessionTtlHours();
  const ip = opts.req?.headers.get("cf-connecting-ip") || opts.req?.headers.get("x-real-ip") || null;
  const ua = opts.req?.headers.get("user-agent")?.slice(0, 400) ?? null;
  await dbQuery(
    `INSERT INTO admin_sessions (token, user_id, kind, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now(), now() + ($6::numeric * interval '1 hour'))`,
    [hashAdminSessionToken(token), opts.userId, opts.kind ?? "otp", ip, ua, ttl],
  );
  const maxAge = Math.round(ttl * 3600);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieFlags()}`;
}

export function getClearAdminCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieFlags()}`;
}

export async function revokeAdminSessionToken(token: string): Promise<void> {
  await dbQuery(`UPDATE admin_sessions SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL`, [
    hashAdminSessionToken(token),
  ]);
}

/** Revocă toate sesiunile de admin ale unui cont (retrogradare, suspendare, schimbare de rol). */
export async function revokeAdminSessionsForUser(
  userId: string,
  query: (sql: string, params: unknown[]) => Promise<unknown> = dbQuery,
): Promise<void> {
  await query(`UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}
