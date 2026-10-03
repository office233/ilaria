/**
 * Cont nou prin cod pe email, FĂRĂ a crea contul înainte de verificare.
 *
 * `login` pentru o adresă necunoscută → codul se păstrează în `pending_signups`;
 * `verify_otp` corect → abia atunci se creează rândul din `users` (email deja
 * confirmat, limba reală a utilizatorului) + bun venit.
 */
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Locale } from "@/lib/i18n/config";
import { reservedUsernames } from "@/lib/social/config";
import { markEmailVerified } from "./email-verification";
import { OTP_TTL_MINUTES } from "./ttl";

const MAX_ATTEMPTS = 5;
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export function generateUsername(email: string): string {
  const prefix = email.split("@")[0].replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
  const base = prefix && !reservedUsernames().has(prefix) ? prefix : "user";
  return `${base}_${crypto.randomBytes(3).toString("hex")}`;
}

export async function stagePendingSignup(email: string, locale: Locale): Promise<string> {
  const otp = crypto.randomInt(100000, 1000000).toString();
  await dbQuery(
    `INSERT INTO pending_signups (email_lower, otp_hash, locale, attempts, expires_at)
     VALUES (lower($1), $2, $3, 0, now() + make_interval(mins => $4))
     ON CONFLICT (email_lower) DO UPDATE
       SET otp_hash = EXCLUDED.otp_hash, locale = EXCLUDED.locale, attempts = 0,
           expires_at = EXCLUDED.expires_at, created_at = now()`,
    [email, sha256(`otp:${otp}`), locale, OTP_TTL_MINUTES],
  );
  return otp;
}

/** Codul corect → rândul e consumat și se întoarce limba aleasă la cerere. */
export async function consumePendingSignup(email: string, otp: string): Promise<{ locale: string } | null> {
  const { rows } = await dbQuery<{ otp_hash: string; attempts: number }>(
    `UPDATE pending_signups SET attempts = attempts + 1
      WHERE email_lower = lower($1) AND expires_at > now()
      RETURNING otp_hash, attempts`,
    [email],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.attempts > MAX_ATTEMPTS) {
    await dbQuery(`DELETE FROM pending_signups WHERE email_lower = lower($1)`, [email]);
    return null;
  }
  const given = Buffer.from(sha256(`otp:${String(otp).trim()}`));
  const expected = Buffer.from(row.otp_hash);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const { rows: del } = await dbQuery<{ locale: string }>(
    `DELETE FROM pending_signups WHERE email_lower = lower($1) AND otp_hash = $2 RETURNING locale`,
    [email, row.otp_hash],
  );
  return del[0] ?? null;
}

/**
 * Creează contul după verificarea codului. La o cursă (contul a apărut între
 * timp), întoarce contul existent. Emailul e marcat confirmat → bun venit.
 */
export async function createVerifiedUser(email: string, locale: string): Promise<string> {
  let userId: string | undefined;
  try {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO users (username, email, display_name, locale, role, status, metadata, auth_providers)
       VALUES ($1, $2, $3, $4, 'creator', 'active', '{}', ARRAY['email_otp']::text[])
       RETURNING id`,
      [generateUsername(email), email, email.split("@")[0], locale],
    );
    userId = rows[0]?.id;
  } catch (err) {
    if ((err as { code?: string })?.code !== "23505") throw err;
  }
  if (!userId) {
    const { rows } = await dbQuery<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
    userId = rows[0]?.id;
    if (!userId) throw new Error("user creation race without a winner");
    return userId;
  }
  await dbQuery(
    `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  ).catch((err) => logger.warn({ err }, "[auth/otp_signup] notification_preferences insert failed"));
  await markEmailVerified(userId);
  return userId;
}
