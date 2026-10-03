/**
 * Customer / unified Auth API — backed by `users` + `user_sessions` tables.
 *
 * POST /api/auth   { action: "login",         email, locale? }              → send login code
 *                    (adresă fără cont: codul stă în pending_signups; contul se creează la verify_otp)
 * POST /api/auth   { action: "resend_otp",    email }                       → re-send login code
 * POST /api/auth   { action: "verify_otp",    email, token, next? }         → verify code → 30-day session
 *                                                                              (sau requires2FA dacă TOTP e activ)
 * POST /api/auth   { action: "resend_verification" }                        → link nou de confirmare email (authed)
 * POST /api/auth   { action: "verify_email",   token }                      → confirmă emailul din link
 * POST /api/auth   { action: "signup_password",
 *                    email, password, first_name, last_name,
 *                    username, phone?, avatar_url?, next? }                 → create account with password
 * POST /api/auth   { action: "login_password", email, password, next? }     → login with email + password
 * POST /api/auth   { action: "set_password",   password }                   → set/change password (authed)
 * POST /api/auth   { action: "check_username", username }                   → { available: true|false }
 * POST /api/auth   { action: "update_profile", name, phone, address }       → update extended profile
 * POST /api/auth   { action: "forgot_password" | "reset_password", … }
 * POST /api/auth   { action: "logout" }
 *
 * Erorile au `code` stabil + `error` tradus în limba cererii (lib/auth/api-errors).
 * GET  /api/auth                                                            → verify current session
 * DELETE /api/auth                                                          → logout (alias)
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import { dbQuery } from "@/lib/db";
import { resetPasswordWithToken } from "@/lib/auth/reset-password";
import { sendMagicLink } from "@/lib/email/service";
import { sendPasswordResetEmail } from "@/lib/email/templates/auth";
import { emailConfigured } from "@/lib/email/transport";
import { localeFromRequest, normalizeLocale, translator } from "@/lib/email/i18n";
import type { Locale } from "@/lib/i18n/config";
import { authFail, authMessage, type AuthErrorCode } from "@/lib/auth/api-errors";
import { consumeEmailVerification, issueEmailVerification, markEmailVerified } from "@/lib/auth/email-verification";
import { consumePendingSignup, createVerifiedUser, stagePendingSignup } from "@/lib/auth/pending-signup";
import { OTP_TTL_MINUTES, PASSWORD_RESET_TTL_MINUTES } from "@/lib/auth/ttl";
import { checkUsernameAvailable, normalizeUsername, type UsernameProblem } from "@/lib/social/username";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "/api/auth" });
import { attributeOnSignup } from "@/lib/referral/attribution";
import {
  hashSessionToken,
  resolvePostLoginRedirect,
  type AuthRole,
} from "@/lib/auth/session";
import {
  createAdminSessionAndGetCookie,
  revokeAdminSessionsForUser,
  getAdminCookieName,
} from "@/lib/security/admin-auth";
import { CART_COOKIE, mergeAnonCartToUser } from "@/lib/cart/session";
import { getAnonShellUserId } from "@/lib/social/session";
import { mergeAnonSocialToUser } from "@/lib/social/merge-anon";
import { APP_URL } from "@/lib/app-url";

const COOKIE_NAME = "swypik_session";
const SELLER_COOKIE_NAME = "seller_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const isProd = process.env.NODE_ENV === "production";
const SECURE_FLAG = isProd ? "; Secure" : "";

// Extract domain from APP_URL (e.g., https://swypik.com → swypik.com)
function getCookieDomain(): string | undefined {
  if (!isProd) return undefined;
  try {
    const url = new URL(APP_URL);
    return url.hostname;
  } catch {
    return undefined;
  }
}

const COOKIE_DOMAIN = getCookieDomain();
const COOKIE_DOMAIN_FLAG = COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : "";

/* ────────────────────────────────────────── helpers ──── */

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const USERNAME_ERROR: Record<UsernameProblem, AuthErrorCode> = {
  username_invalid: "usernameInvalid",
  username_reserved: "usernameReserved",
  username_taken: "usernameTaken",
};

function isValidPassword(value: string): boolean {
  return typeof value === "string" && value.length >= 8 && value.length <= 200;
}

function isValidEmail(value: string): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value: string): boolean {
  // E.164-ish; allow + and 7-15 digits
  return /^\+?[0-9]{7,15}$/.test(value.replace(/\s|-/g, ""));
}

function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE_FLAG}${COOKIE_DOMAIN_FLAG}`;
}

function appendSetCookie(response: NextResponse, cookie: string): void {
  // FIX: NextResponse.cookies.set() rebuilds the Set-Cookie header on serialize
  // and overwrites any raw headers.append("Set-Cookie", ...) calls. So we parse
  // the cookie string and route through the cookie store instead.
  const parts = cookie.split("; ");
  const pair = parts[0];
  const eq = pair.indexOf("=");
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const opts: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
    maxAge?: number;
    domain?: string;
    expires?: Date;
  } = {};
  for (let i = 1; i < parts.length; i++) {
    const [k, v] = parts[i].split("=");
    const key = (k || "").toLowerCase();
    if (key === "path") opts.path = v;
    else if (key === "httponly") opts.httpOnly = true;
    else if (key === "secure") opts.secure = true;
    else if (key === "samesite") opts.sameSite = ((v || "lax").toLowerCase() as "lax" | "strict" | "none");
    else if (key === "max-age") opts.maxAge = parseInt(v, 10);
    else if (key === "domain") opts.domain = v;
    else if (key === "expires") opts.expires = new Date(v);
  }
  response.cookies.set(name, value, opts);
}

/**
 * Issue a 30-day session for `userId`, set cookies, attach admin/seller cookies
 * if applicable, and return the JSON response.
 */
async function issueSessionResponse(
  userId: string,
  normalizedEmail: string,
  nextPath: string | null,
  req?: Request,
) {
  const sessionToken = generateToken();
  const sessionHash = hashSessionToken(sessionToken);

  // Telemetrie sesiune (IP + user agent) — folosită în panourile admin
  // (ex: /admin/fleet) pentru verificarea șoferilor/curierilor.
  const ip = req ? getClientIP(req) : null;
  const ua = req?.headers.get("user-agent")?.slice(0, 400) ?? null;

  await dbQuery(
    `INSERT INTO user_sessions (user_id, session_token_hash, expires_at, metadata,
                                ip_address, user_agent, last_seen_at)
     VALUES ($1, $2, now() + interval '30 days', $3::jsonb, $4::inet, $5, now())`,
    [userId, sessionHash, JSON.stringify({ type: "session" }),
      ip && ip !== "unknown" ? ip : null, ua],
  );
  // Merge anonymous cart (if any) into this user's cart.
  try {
    const cookieStore = await cookies();
    const anonToken = cookieStore.get(CART_COOKIE)?.value || null;
    if (anonToken) await mergeAnonCartToUser(anonToken, userId);
  } catch (err) {
    logger.warn({ err }, "[auth] cart merge failed");
  }
  // Migrează și activitatea socială anonimă (like-uri, salvări, follow-uri) —
  // altfel inimile date înainte de login dispăreau la autentificare
  // (audit 2026-08-25). Best-effort, nu blochează login-ul.
  try {
    const anonUserId = await getAnonShellUserId();
    if (anonUserId) await mergeAnonSocialToUser(anonUserId, userId);
  } catch (err) {
    logger.warn({ err }, "[auth] social merge failed");
  }
  await dbQuery(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);

  const { rows: userRows } = await dbQuery<{
    id: string;
    email: string;
    display_name: string;
    username: string;
    role: string;
    email_verified_at: string | null;
  }>(
    `SELECT id, email, display_name, username, role, email_verified_at
     FROM users WHERE id = $1`,
    [userId],
  );
  const user = userRows[0];

  let role: AuthRole =
    user?.role === "admin"
      ? "admin"
      : user?.role === "creator"
        ? "creator"
        : "shopper";
  let sellerId: string | null = null;

  // Rolul de seller se deriva din potrivirea email-ului cu un rand `sellers`
  // aprobat. Acordarea DOAR cu email VERIFICAT (audit 2026-08-25): altfel un
  // atacator isi facea cont cu parola pe emailul public al unui seller aprobat
  // care nu si-a creat inca cont, si prelua portalul acelui seller. OTP-ul si
  // verify_otp (linia ~863) seteaza email_verified_at — deci un seller care se
  // logheaza prin cod pe emailul lui trece normal.
  if (role !== "admin" && user?.email_verified_at) {
    try {
      const { rows: sellerRows } = await dbQuery<{ id: string }>(
        `SELECT id FROM sellers
         WHERE lower(email) = $1
           AND status IN ('active', 'approved')
         LIMIT 1`,
        [normalizedEmail],
      );
      if (sellerRows[0]?.id) {
        role = "seller";
        sellerId = sellerRows[0].id;
      }
    } catch {
      /* sellers table missing in some envs — ignore */
    }
  }

  const { rows: onboardedRows } = await dbQuery<{ onboarded: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM users WHERE id = $1 AND onboarding_completed_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM user_interests WHERE user_id = $1)
       OR EXISTS (SELECT 1 FROM users WHERE id = $1 AND created_at < now() - interval '1 hour')
     ) AS onboarded`,
    [userId],
  ).catch(() => ({ rows: [{ onboarded: false }] }));
  const alreadyOnboarded = Boolean(onboardedRows[0]?.onboarded);

  const redirectTo = resolvePostLoginRedirect(role, nextPath);

  const response = NextResponse.json({
    success: true,
    user: user || { id: userId },
    role,
    sellerId,
    redirectTo,
    onboarded: alreadyOnboarded,
    emailVerified: Boolean(user?.email_verified_at),
  });

  appendSetCookie(
    response,
    `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${SECURE_FLAG}${COOKIE_DOMAIN_FLAG}`,
  );

  if (role === "admin") {
    try {
      // Sesiune de admin legată de acest cont (per-admin, 12h; vezi lib/security/admin-auth.ts).
      const adminCookie = await createAdminSessionAndGetCookie({ userId, kind: "otp", req });
      appendSetCookie(response, adminCookie);
    } catch (err) {
      logger.warn({ err }, "[auth] could not create admin cookie");
    }
  }

  if (role === "seller" && sellerId) {
    try {
      const sellerToken = generateToken();
      const sellerHash = hashToken(sellerToken);
      await dbQuery(
        `INSERT INTO seller_sessions (seller_id, token, expires_at, created_at)
         VALUES ($1, $2, now() + interval '30 days', now())`,
        [sellerId, sellerHash],
      );
      appendSetCookie(
        response,
        `${SELLER_COOKIE_NAME}=${sellerToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${SECURE_FLAG}${COOKIE_DOMAIN_FLAG}`,
      );
    } catch (err) {
      logger.warn({ err }, "[auth] could not create seller cookie");
    }
  }

  if (alreadyOnboarded) {
    response.cookies.set("swypik_onboarded", "1", {
      domain: COOKIE_DOMAIN,
      path: "/",
      maxAge: 60 * 60 * 24 * 730,
      sameSite: "lax",
      secure: isProd,
      httpOnly: true,
    });
  }

  return response;
}

/** Utilizatorul sesiunii curente (cookie `swypik_session`), sau null. */
async function sessionUserId(sessionToken: string | undefined): Promise<{ userId: string; sessionHash: string } | null> {
  if (!sessionToken) return null;
  const sessionHash = hashSessionToken(sessionToken);
  const { rows } = await dbQuery<{ user_id: string }>(
    `SELECT user_id FROM user_sessions
     WHERE session_token_hash = $1
       AND COALESCE(metadata->>'type', 'session') = 'session'
       AND expires_at > now() AND revoked_at IS NULL`,
    [sessionHash],
  );
  return rows[0] ? { userId: rows[0].user_id, sessionHash } : null;
}

/** Provocarea 2FA (Redis, 5 min) — folosită după parolă ȘI după codul pe email. */
async function twoFactorChallenge(req: Request, userId: string, email: string, next: unknown) {
  try {
    const { getRedis } = await import("@/lib/redis");
    const tempToken = generateToken();
    await getRedis().set(
      `2fa:pending:${tempToken}`,
      JSON.stringify({ userId, email, next: typeof next === "string" ? next : null }),
      "EX",
      300,
    );
    return NextResponse.json({ success: true, requires2FA: true, tempToken });
  } catch (e) {
    logger.warn({ err: e }, "[auth] 2FA redis failed");
    return authFail(req, "temporaryError", 500);
  }
}

/** Trimite codul de login. Fără cont → cod „în așteptare", contul se creează abia la verificare. */
async function handleSendOtp(req: Request, rawEmail: unknown, locale: Locale) {
  if (typeof rawEmail !== "string" || !isValidEmail(rawEmail.trim())) {
    return authFail(req, "invalidEmail", 400);
  }
  const normalizedEmail = rawEmail.trim().toLowerCase();

  const ip = getClientIP(req);
  const ipLimit = await rateLimit("auth-otp-ip", ip, { limit: 10, window: 300 });
  if (!ipLimit.success) return authFail(req, "rateLimited", 429);
  const emailLimit = await rateLimit("auth-otp-email", normalizedEmail, { limit: 5, window: 300 });
  if (!emailLimit.success) return authFail(req, "tooManyCodes", 429);

  const { rows } = await dbQuery<{ id: string; status: string; locale: string | null }>(
    `SELECT id, status, locale FROM users WHERE email IS NOT NULL AND lower(email) = $1 LIMIT 1`,
    [normalizedEmail],
  );
  const existing = rows[0];
  const canExposeDevOtp = process.env.NODE_ENV !== "production" && !emailConfigured();

  // Cont blocat: răspuns identic (fără enumerare), dar niciun cod.
  if (existing && !["active", "pending_verification"].includes(existing.status)) {
    return NextResponse.json({ success: true, requiresVerification: true });
  }
  if (!emailConfigured() && !canExposeDevOtp) {
    return authFail(req, "emailUnavailable", 503);
  }

  let otp: string;
  if (existing) {
    otp = crypto.randomInt(100000, 1000000).toString();
    // Revocăm codurile anterioare încă vii: fiecare cod activ în plus
    // înmulțea șansele unui atac prin ghicire (audit 2026-08-25).
    await dbQuery(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE user_id = $1 AND metadata->>'type' = 'otp' AND revoked_at IS NULL`,
      [existing.id],
    );
    await dbQuery(
      `INSERT INTO user_sessions (user_id, session_token_hash, expires_at, metadata)
       VALUES ($1, $2, now() + make_interval(mins => $4), $3::jsonb)`,
      [existing.id, hashToken(`otp:${otp}`), JSON.stringify({ type: "otp" }), OTP_TTL_MINUTES],
    );
  } else {
    otp = await stagePendingSignup(normalizedEmail, locale);
  }

  const mailLocale = existing ? normalizeLocale(existing.locale) : locale;
  const sent = await sendMagicLink(normalizedEmail, otp, mailLocale);
  if (!sent && !canExposeDevOtp) return authFail(req, "sendFailed", 502);

  return NextResponse.json({
    success: true,
    requiresVerification: true,
    ...(canExposeDevOtp ? { devOtp: otp } : {}),
  });
}

/** Cont nou după codul corect pentru o adresă fără cont (pending_signups). */
async function completePendingSignup(req: Request, normalizedEmail: string, token: string, next: unknown) {
  const pending = await consumePendingSignup(normalizedEmail, token);
  if (!pending) return authFail(req, "codeInvalid", 400);
  const userId = await createVerifiedUser(normalizedEmail, normalizeLocale(pending.locale));
  const { rows } = await dbQuery<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId]);
  if (rows[0] && !["active", "pending_verification"].includes(rows[0].status)) {
    return authFail(req, "accountSuspended", 403);
  }
  try {
    await attributeOnSignup({ inviteeUserId: userId });
  } catch (err) {
    logger.warn({ err }, "[auth/otp_signup] referral attribution failed");
  }
  try {
    const { checkRecreationAndMaybeBlock } = await import("@/lib/risk/recreation-detection");
    await checkRecreationAndMaybeBlock({
      userId,
      email: normalizedEmail,
      ip: getClientIP(req),
      ipCountry: req.headers.get("cf-ipcountry"),
      userAgent: req.headers.get("user-agent"),
      signupPath: "otp_email",
    });
  } catch (err) {
    logger.warn({ err }, "[auth/otp_signup] recreation check failed");
  }
  return issueSessionResponse(userId, normalizedEmail, typeof next === "string" ? next : null, req);
}

/* ──────────────────────────────────── POST handler ──── */

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const {
    action,
    email,
    token,
    name,
    phone,
    address,
    next,
    password,
    first_name,
    last_name,
    username,
    avatar_url,
  } = body || {};
  const cookieStore = await cookies();
  const locale = localeFromRequest(req, body?.locale);

  switch (action) {
    /* ═══════════════════ CHECK USERNAME ═══════════════════ */
    case "check_username": {
      const rl = await rateLimit("auth-username-check", getClientIP(req), { limit: 60, window: 60 });
      if (!rl.success) return authFail(req, "rateLimited", 429);
      const handle = normalizeUsername(username);
      // Format, nume rezervate, username-uri curente ȘI aliasurile vechi (/u/<alias>).
      const problem = await checkUsernameAvailable(handle, null);
      if (problem) {
        const code = USERNAME_ERROR[problem];
        return NextResponse.json({
          available: false,
          valid: problem !== "username_invalid",
          reason: problem,
          code,
          error: await authMessage(req, code),
        });
      }
      return NextResponse.json({ available: true, valid: true });
    }

    /* ═══════════════════ SIGNUP WITH PASSWORD ═══════════════════ */
    case "signup_password": {
      if (!isValidEmail(email)) return authFail(req, "invalidEmail", 400, { field: "email" });
      if (!isValidPassword(password)) return authFail(req, "passwordTooShort", 400, { field: "password" });
      if (typeof first_name !== "string" || first_name.trim().length < 1) {
        return authFail(req, "firstNameRequired", 400, { field: "first_name" });
      }
      if (typeof last_name !== "string" || last_name.trim().length < 1) {
        return authFail(req, "lastNameRequired", 400, { field: "last_name" });
      }
      const phoneTrimmed = typeof phone === "string" ? phone.trim() : "";
      if (phoneTrimmed && !isValidPhone(phoneTrimmed)) return authFail(req, "phoneInvalid", 400, { field: "phone" });

      const normalizedEmail = String(email).trim().toLowerCase();
      const cleanUsername = normalizeUsername(username);

      const signupLimit = await rateLimit("auth-signup-ip", getClientIP(req), { limit: 5, window: 600 });
      if (!signupLimit.success) return authFail(req, "rateLimited", 429);

      const { rows: existingEmailRows } = await dbQuery<{ id: string; status: string }>(
        `SELECT id, status FROM users WHERE email IS NOT NULL AND lower(email) = $1 LIMIT 1`,
        [normalizedEmail],
      );
      if (existingEmailRows.length > 0) {
        log.info({ action: "signup_password", outcome: "email_taken", user_id: existingEmailRows[0].id }, "signup blocked");
        return authFail(req, "emailTaken", 409, { field: "email" });
      }

      // Nume rezervate + username-uri curente + aliasuri vechi (lib/social/username).
      const usernameProblem = await checkUsernameAvailable(cleanUsername, null);
      if (usernameProblem) {
        log.info({ action: "signup_password", outcome: usernameProblem }, "signup blocked");
        return authFail(req, USERNAME_ERROR[usernameProblem], usernameProblem === "username_taken" ? 409 : 400, {
          field: "username",
        });
      }

      if (phoneTrimmed) {
        const { rows: existingPhoneRows } = await dbQuery<{ id: string }>(
          `SELECT id FROM users WHERE phone IS NOT NULL AND phone = $1 LIMIT 1`,
          [phoneTrimmed],
        );
        if (existingPhoneRows.length > 0) return authFail(req, "phoneTaken", 409, { field: "phone" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const displayName = `${first_name.trim()} ${last_name.trim()}`.trim();

      let userId: string;
      try {
        const { rows: insertRows } = await dbQuery<{ id: string }>(
          `INSERT INTO users (
             username, email, display_name, first_name, last_name,
             phone, avatar_url, password_hash, password_set_at,
             locale, role, status, suspend_grace_until, auth_providers, metadata
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8, now(),
             $9, 'creator', 'active',
             NULL,
             ARRAY['email_password']::text[],
             '{}'::jsonb
           )
           RETURNING id`,
          [
            cleanUsername,
            normalizedEmail,
            displayName,
            first_name.trim(),
            last_name.trim(),
            phoneTrimmed || null,
            typeof avatar_url === "string" && /^https:\/\//i.test(avatar_url) ? avatar_url : null,
            passwordHash,
            locale,
          ],
        );
        userId = insertRows[0].id;
      } catch (err) {
        // Cursă între două înregistrări simultane → violare de unicitate, nu 500.
        if ((err as { code?: string })?.code === "23505") {
          const constraint = String((err as { constraint?: string })?.constraint ?? "");
          const field = constraint.includes("username") ? "username" : constraint.includes("phone") ? "phone" : "email";
          const code: AuthErrorCode = field === "username" ? "usernameTaken" : field === "phone" ? "phoneTaken" : "emailTaken";
          return authFail(req, code, 409, { field });
        }
        throw err;
      }

      try {
        await dbQuery(
          `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
      } catch (err) {
        logger.warn({ err }, "[auth/signup_password] default rows insert failed");
      }

      try {
        await attributeOnSignup({ inviteeUserId: userId });
      } catch (err) {
        logger.warn({ err }, "[auth/signup_password] referral attribution failed");
      }

      try {
        const { checkRecreationAndMaybeBlock } = await import("@/lib/risk/recreation-detection");
        await checkRecreationAndMaybeBlock({
          userId,
          email: normalizedEmail,
          phone: phoneTrimmed || null,
          ip: getClientIP(req),
          ipCountry: req.headers.get("cf-ipcountry"),
          userAgent: req.headers.get("user-agent"),
          signupPath: "password",
        });
      } catch (err) {
        logger.warn({ err }, "[auth/signup_password] recreation check failed");
      }

      // Un singur email acum: linkul de confirmare. Bun venit-ul pleacă abia
      // după confirmare (lib/auth/email-verification.markEmailVerified).
      issueEmailVerification(userId, normalizedEmail, locale).catch((err) =>
        logger.warn({ err }, "[auth/signup_password] verification email failed"),
      );

      return issueSessionResponse(userId, normalizedEmail, typeof next === "string" ? next : null, req);
    }

    /* ═══════════════════ LOGIN WITH PASSWORD ═══════════════════ */
    case "login_password": {
      if (!isValidEmail(email) || typeof password !== "string") return authFail(req, "credentialsInvalid", 400);
      const limit = await rateLimit("auth-login-pw-ip", getClientIP(req), { limit: 10, window: 300 });
      if (!limit.success) return authFail(req, "rateLimited", 429);

      const normalizedEmail = String(email).trim().toLowerCase();
      const { rows } = await dbQuery<{ id: string; password_hash: string | null; status: string; totp_enabled_at: string | null; suspended_until: string | null }>(
        `SELECT id, password_hash, status, totp_enabled_at, suspended_until
         FROM users WHERE lower(email) = $1 LIMIT 1`,
        [normalizedEmail],
      );

      const user = rows[0];
      if (!user || !user.password_hash) return authFail(req, "credentialsInvalid", 401);
      // Suspendarea temporară (suspended_until) trebuie să reziste la re-login (audit 2026-08-25).
      const suspendedUntilActive =
        user.suspended_until != null && new Date(user.suspended_until).getTime() > Date.now();
      if (user.status === "suspended" || user.status === "banned" || user.status === "deleted" || suspendedUntilActive) {
        return authFail(req, "accountSuspended", 403);
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return authFail(req, "credentialsInvalid", 401);

      if (user.totp_enabled_at) return twoFactorChallenge(req, user.id, normalizedEmail, next);

      return issueSessionResponse(user.id, normalizedEmail, typeof next === "string" ? next : null, req);
    }

    /* ═══════════════════ VERIFY 2FA ═══════════════════ */
    case "verify_2fa": {
      const tempToken = String(body.tempToken || "");
      const code = String(body.code || "").trim();
      if (!/^[0-9a-f]{64}$/.test(tempToken) || !/^(?:[0-9]{6}|[0-9a-fA-F]{8})$/.test(code)) {
        return authFail(req, "invalidRequest", 400);
      }
      const ipLimit = await rateLimit("auth-2fa-ip", getClientIP(req), { limit: 20, window: 300 });
      const challengeLimit = await rateLimit("auth-2fa-challenge", tempToken, { limit: 5, window: 300 });
      if (!ipLimit.success || !challengeLimit.success) return authFail(req, "rateLimited", 429);
      try {
        const { getRedis } = await import("@/lib/redis");
        const { verifyToken } = await import("@/lib/auth/totp");
        const raw = await getRedis().get(`2fa:pending:${tempToken}`);
        if (!raw) return authFail(req, "twoFactorExpired", 401);
        const payload = JSON.parse(raw) as { userId: string; email: string; next: string | null };
        const { rows: urows } = await dbQuery<{ totp_secret: string | null; totp_backup_codes: string[] | null }>(
          `SELECT totp_secret, totp_backup_codes FROM users WHERE id = $1
             AND COALESCE(status, 'active') NOT IN ('suspended', 'banned', 'deleted')
             AND (suspended_until IS NULL OR suspended_until <= now())`,
          [payload.userId],
        );
        if (urows.length === 0 || !urows[0].totp_secret) return authFail(req, "twoFactorInactive", 400);
        let valid = /^\d{6}$/.test(code) && verifyToken(urows[0].totp_secret, code);

        // Coduri de rezervă (8 hex) dacă TOTP eșuează.
        if (!valid && /^[0-9a-fA-F]{8}$/.test(code) && urows[0].totp_backup_codes) {
          const { consumeBackupCode } = await import("@/lib/auth/totp");
          const result = await consumeBackupCode(urows[0].totp_backup_codes, code);
          if (result.matched) {
            // Compare-and-swap: doar o cerere poate consuma lista veche.
            const consumedBackup = await dbQuery(
              `UPDATE users SET totp_backup_codes = $1
               WHERE id = $2 AND totp_backup_codes = $3 RETURNING id`,
              [result.remaining, payload.userId, urows[0].totp_backup_codes],
            );
            valid = consumedBackup.rows.length === 1;
          }
        }

        if (!valid) return authFail(req, "twoFactorInvalid", 401);

        // O singură cerere reușită poate consuma provocarea.
        const consumed = await getRedis().del(`2fa:pending:${tempToken}`);
        if (consumed !== 1) return authFail(req, "twoFactorExpired", 401);
        return issueSessionResponse(payload.userId, payload.email, payload.next, req);
      } catch (e) {
        logger.warn({ err: e }, "[auth] verify_2fa failed");
        return authFail(req, "temporaryError", 500);
      }
    }

    /* ═══════════════════ SET / CHANGE PASSWORD (authed) ═══════════════════ */
    case "set_password": {
      const session = await sessionUserId(cookieStore.get(COOKIE_NAME)?.value);
      if (!session) return authFail(req, "notLoggedIn", 401);
      if (!isValidPassword(password)) return authFail(req, "passwordTooShort", 400);
      const { userId, sessionHash } = session;
      const passwordHash = await bcrypt.hash(password, 12);
      await dbQuery(
        `UPDATE users SET
           password_hash = $1,
           password_set_at = now(),
           auth_providers = (
             SELECT array(SELECT DISTINCT unnest(coalesce(auth_providers, ARRAY[]::text[]) || ARRAY['email_password']::text[]))
             FROM users WHERE id = $2
           )
         WHERE id = $2`,
        [passwordHash, userId],
      );
      // Schimbarea parolei evacuează TOATE celelalte sesiuni (audit 2026-08-25).
      await dbQuery(
        `UPDATE user_sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL AND session_token_hash <> $2`,
        [userId, sessionHash],
      );
      await dbQuery(
        `DELETE FROM seller_sessions WHERE seller_id IN (
           SELECT s.id FROM sellers s JOIN users u ON lower(u.email) = lower(s.email) WHERE u.id = $1
         )`,
        [userId],
      ).catch(() => undefined);
      await revokeAdminSessionsForUser(userId).catch(() => undefined);
      return NextResponse.json({ success: true });
    }

    /* ═══════════════════ LOGIN / RESEND OTP ═══════════════════ */
    case "login":
    case "resend_otp": {
      return handleSendOtp(req, email, locale);
    }

    /* ═══════════════════ VERIFY OTP ═══════════════════ */
    case "verify_otp": {
      if (!email || !token) return authFail(req, "codeRequired", 400);
      const verifyLimit = await rateLimit("auth-otp-verify", getClientIP(req), { limit: 15, window: 300 });
      if (!verifyLimit.success) return authFail(req, "rateLimited", 429);

      const normalizedEmail = String(email).trim().toLowerCase();
      const otpHash = hashToken(`otp:${String(token).trim()}`);

      const { rows } = await dbQuery<{ id: string; user_id: string; totp_enabled_at: string | null }>(
        `SELECT us.id, us.user_id, u.totp_enabled_at
         FROM user_sessions us
         JOIN users u ON u.id = us.user_id
         WHERE lower(u.email) = $1
           AND us.session_token_hash = $2
           AND us.expires_at > now()
           AND us.revoked_at IS NULL
           AND us.metadata->>'type' = 'otp'
           AND COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')
           AND (u.suspended_until IS NULL OR u.suspended_until <= now())
         LIMIT 1`,
        [normalizedEmail, otpHash],
      );

      // Adresă fără cont: codul e în pending_signups; contul se creează acum.
      if (rows.length === 0) return completePendingSignup(req, normalizedEmail, String(token), next);

      const otpSessionId = rows[0].id;
      const userId = rows[0].user_id;

      const consumed = await dbQuery(
        `UPDATE user_sessions SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
         RETURNING id`,
        [otpSessionId],
      );
      if (!consumed.rows[0]) return authFail(req, "codeInvalid", 400);

      // Codul dovedește posesia emailului → emailul e confirmat (bun venit la prima confirmare).
      await markEmailVerified(userId).catch((err) => logger.warn({ err }, "[auth] mark verified failed"));

      // Posesia emailului NU ocolește un autentificator activ: cerem și al
      // doilea factor (și conturile fără parolă pot intra, deci nu se blochează).
      if (rows[0].totp_enabled_at) return twoFactorChallenge(req, userId, normalizedEmail, next);

      return issueSessionResponse(userId, normalizedEmail, typeof next === "string" ? next : null, req);
    }

    /* ═══════════════════ EMAIL VERIFICATION (link) ═══════════════════ */
    case "resend_verification": {
      const session = await sessionUserId(cookieStore.get(COOKIE_NAME)?.value);
      if (!session) return authFail(req, "notLoggedIn", 401);
      const rl = await rateLimit("auth-verify-resend", session.userId, { limit: 3, window: 900 });
      if (!rl.success) return authFail(req, "rateLimited", 429);
      const { rows } = await dbQuery<{ email: string | null; email_verified_at: string | null; locale: string | null }>(
        `SELECT email, email_verified_at, locale FROM users WHERE id = $1`,
        [session.userId],
      );
      const u = rows[0];
      if (!u?.email) return authFail(req, "invalidEmail", 400);
      if (u.email_verified_at) return authFail(req, "alreadyVerified", 409);
      if (!emailConfigured()) return authFail(req, "emailUnavailable", 503);
      const sent = await issueEmailVerification(session.userId, u.email, normalizeLocale(u.locale));
      if (!sent) return authFail(req, "sendFailed", 502);
      return NextResponse.json({ success: true, sent: true });
    }

    case "verify_email": {
      const rl = await rateLimit("auth-verify-email", getClientIP(req), { limit: 20, window: 600 });
      if (!rl.success) return authFail(req, "rateLimited", 429);
      const result = await consumeEmailVerification(String(token ?? ""));
      if (!result.ok) return authFail(req, "tokenInvalid", 400);
      return NextResponse.json({ success: true, verified: true });
    }

    /* ═══════════════════ UPDATE PROFILE ═══════════════════ */
    case "update_profile": {
      const session = await sessionUserId(cookieStore.get(COOKIE_NAME)?.value);
      if (!session) return authFail(req, "notLoggedIn", 401);
      const phoneTrimmed = typeof phone === "string" ? phone.trim() : "";
      if (phoneTrimmed && !isValidPhone(phoneTrimmed)) return authFail(req, "phoneInvalid", 400, { field: "phone" });
      if (phoneTrimmed) {
        const { rows: taken } = await dbQuery<{ id: string }>(
          `SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1`,
          [phoneTrimmed, session.userId],
        );
        if (taken.length) return authFail(req, "phoneTaken", 409, { field: "phone" });
      }
      // Telefonul trăiește într-o singură coloană (`users.phone`), ca la signup.
      await dbQuery(
        `UPDATE users SET
           display_name = COALESCE($1, display_name),
           phone = COALESCE($2, phone),
           metadata = CASE WHEN $3::jsonb IS NULL THEN metadata ELSE jsonb_set(metadata, '{address}', $3::jsonb) END,
           last_seen_at = now()
         WHERE id = $4`,
        [
          typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null,
          phoneTrimmed || null,
          address ? JSON.stringify(address) : null,
          session.userId,
        ],
      );
      return NextResponse.json({ success: true });
    }

    /* ═══════════════════ LOGOUT ═══════════════════ */
    case "logout": {
      const sessionToken = cookieStore.get(COOKIE_NAME)?.value;
      if (sessionToken) {
        await dbQuery(
          `UPDATE user_sessions SET revoked_at = now() WHERE session_token_hash = $1`,
          [hashSessionToken(sessionToken)],
        );
      }

      const sellerToken = cookieStore.get(SELLER_COOKIE_NAME)?.value;
      if (sellerToken) {
        await dbQuery(`DELETE FROM seller_sessions WHERE token = $1`, [
          hashToken(sellerToken),
        ]).catch(() => { });
      }

      const adminToken = cookieStore.get(getAdminCookieName())?.value;
      if (adminToken) {
        await dbQuery(`DELETE FROM admin_sessions WHERE token = $1`, [
          hashToken(adminToken),
        ]).catch(() => { });
      }

      const response = NextResponse.json({ success: true });
      appendSetCookie(response, clearCookieHeader(COOKIE_NAME));
      appendSetCookie(response, clearCookieHeader(SELLER_COOKIE_NAME));
      appendSetCookie(response, clearCookieHeader(getAdminCookieName()));
      return response;
    }

    /* ═══════════════════ FORGOT PASSWORD ═══════════════════ */
    case "forgot_password": {
      const t = await translator(locale, "authEmail.messages");
      const generic = NextResponse.json({ success: true, message: t("resetSent") });
      if (!isValidEmail(email)) return generic;
      const normalizedEmail = String(email).trim().toLowerCase();

      const emailLimit = await rateLimit("auth-forgot-email", normalizedEmail, { limit: 3, window: 3600 });
      const ipLimit = await rateLimit("auth-forgot-ip", getClientIP(req), { limit: 5, window: 3600 });
      if (!emailLimit.success || !ipLimit.success) return generic;
      if (!emailConfigured()) return authFail(req, "emailUnavailable", 503);

      const { rows: userRows } = await dbQuery<{ id: string; first_name: string | null; locale: string | null }>(
        `SELECT id, first_name, locale FROM users
          WHERE lower(email) = $1 AND COALESCE(status, 'active') NOT IN ('banned', 'deleted') LIMIT 1`,
        [normalizedEmail],
      );

      if (userRows.length > 0) {
        const rawToken = generateToken();
        await dbQuery(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + make_interval(mins => $3))`,
          [userRows[0].id, hashToken(rawToken), PASSWORD_RESET_TTL_MINUTES],
        );
        sendPasswordResetEmail(normalizedEmail, rawToken, userRows[0].first_name, normalizeLocale(userRows[0].locale)).catch((err) =>
          logger.error({ err }, "[forgot_password] email error"),
        );
      }
      return generic;
    }

    /* ═══════════════════ RESET PASSWORD ═══════════════════ */
    case "reset_password": {
      const newPassword: unknown = body?.newPassword ?? body?.password;
      const resetToken: unknown = body?.token;
      if (typeof resetToken !== "string" || resetToken.length < 32) return authFail(req, "tokenInvalid", 400);
      if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 200) {
        return authFail(req, "passwordTooShort", 400);
      }
      if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return authFail(req, "passwordWeak", 400);

      const rl = await rateLimit("auth-reset", getClientIP(req), { limit: 10, window: 600 });
      if (!rl.success) return authFail(req, "rateLimited", 429);

      const passwordHash = await bcrypt.hash(newPassword, 12);
      try {
        const reset = await resetPasswordWithToken(hashToken(resetToken), passwordHash);
        if (!reset) return authFail(req, "tokenInvalid", 400);
      } catch (e) {
        logger.error({ err: e }, "[reset_password] tx error");
        return authFail(req, "resetFailed", 500);
      }
      const t = await translator(locale, "authEmail.messages");
      return NextResponse.json({ success: true, message: t("resetDone") });
    }

    default:
      return authFail(req, "unknownAction", 400);
  }
}

/* ──────────────────────────────────── GET handler ──── */

export async function GET() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(COOKIE_NAME)?.value;

  if (!sessionToken) {
    return NextResponse.json({ authenticated: false });
  }

  const sessionHash = hashSessionToken(sessionToken);

  const { rows } = await dbQuery<{
    user_id: string;
    email: string;
    display_name: string;
    username: string;
    avatar_url: string | null;
    role: string;
    metadata: Record<string, unknown>;
    email_verified_at: string | null;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    bio: string | null;
    suspend_grace_until: string | null;
    has_password: boolean;
  }>(
    `SELECT
       us.user_id,
       u.email,
       u.display_name,
       u.username,
       u.avatar_url,
       u.role,
       u.metadata,
       u.email_verified_at,
       u.phone,
       u.first_name,
       u.last_name,
       u.bio,
       u.suspend_grace_until,
       (u.password_hash IS NOT NULL) AS has_password
     FROM user_sessions us
     JOIN users u ON u.id = us.user_id
     WHERE us.session_token_hash = $1
       AND COALESCE(us.metadata->>'type', 'session') = 'session'
       AND us.expires_at > now()
       AND us.revoked_at IS NULL
     LIMIT 1`,
    [sessionHash],
  );

  if (rows.length === 0) {
    return NextResponse.json({ authenticated: false });
  }

  const user = rows[0];

  dbQuery(`UPDATE user_sessions SET last_seen_at = now() WHERE session_token_hash = $1`, [
    sessionHash,
  ]).catch(() => { });
  dbQuery(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [user.user_id]).catch(
    () => { },
  );

  const { rows: orderStats } = await dbQuery<{ count: string }>(
    `SELECT COUNT(*) as count FROM commerce_orders
     WHERE buyer_user_id = $1 AND status != 'cancelled'`,
    [user.user_id],
  ).catch(() => ({ rows: [{ count: "0" }] }));

  return NextResponse.json({
    authenticated: true,
    customer: {
      id: user.user_id,
      email: user.email,
      name: user.display_name,
      display_name: user.display_name,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
      avatar_url: user.avatar_url,
      bio: user.bio,
      role: user.role,
      phone: user.phone || (user.metadata as { phone?: unknown })?.phone || null,
      emailVerified: Boolean(user.email_verified_at),
      suspendGraceUntil: user.suspend_grace_until,
      hasPassword: Boolean(user.has_password),
    },
    orderCount: parseInt(orderStats[0]?.count || "0"),
  });
}

/* ──────────────────────────────────── DELETE handler ──── */

export async function DELETE() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(COOKIE_NAME)?.value;

  if (sessionToken) {
    await dbQuery(
      `UPDATE user_sessions SET revoked_at = now() WHERE session_token_hash = $1`,
      [hashSessionToken(sessionToken)],
    );
  }

  const sellerToken = cookieStore.get(SELLER_COOKIE_NAME)?.value;
  if (sellerToken) {
    await dbQuery(`DELETE FROM seller_sessions WHERE token = $1`, [
      hashToken(sellerToken),
    ]).catch(() => { });
  }
  const adminToken = cookieStore.get(getAdminCookieName())?.value;
  if (adminToken) {
    await dbQuery(`DELETE FROM admin_sessions WHERE token = $1`, [
      hashToken(adminToken),
    ]).catch(() => { });
  }

  const response = NextResponse.json({ success: true });
  appendSetCookie(response, clearCookieHeader(COOKIE_NAME));
  appendSetCookie(response, clearCookieHeader(SELLER_COOKIE_NAME));
  appendSetCookie(response, clearCookieHeader(getAdminCookieName()));
  return response;
}
