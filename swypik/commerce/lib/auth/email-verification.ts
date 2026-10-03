/**
 * Confirmarea adresei de email printr-un link de unică folosință, separat de
 * codul de login. Primul moment în care un cont devine „email confirmat"
 * declanșează emailul de bun venit (o singură dată, cu prenumele).
 */
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Locale } from "@/lib/i18n/config";
import { normalizeLocale } from "@/lib/email/i18n";
import { sendVerifyEmail, sendWelcomeEmail } from "@/lib/email/templates/auth";
import { EMAIL_VERIFY_TTL_HOURS } from "./ttl";

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

/** Creează un token nou (le invalidează pe cele vechi) și trimite emailul. */
export async function issueEmailVerification(userId: string, email: string, locale: Locale): Promise<boolean> {
  const token = crypto.randomBytes(32).toString("base64url");
  await dbQuery(
    `UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  await dbQuery(
    `INSERT INTO email_verification_tokens (user_id, email_lower, token_hash, expires_at)
     VALUES ($1, lower($2), $3, now() + make_interval(hours => $4))`,
    [userId, email, sha256(token), EMAIL_VERIFY_TTL_HOURS],
  );
  return sendVerifyEmail(email, token, locale);
}

/**
 * Marchează emailul ca verificat. Returnează true DOAR la prima verificare
 * (atunci se trimite și bun venit-ul).
 */
export async function markEmailVerified(userId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ email: string | null; first_name: string | null; locale: string | null }>(
    `UPDATE users SET
       email_verified_at = now(),
       suspend_grace_until = NULL,
       status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
     WHERE id = $1 AND email_verified_at IS NULL
     RETURNING email, first_name, locale`,
    [userId],
  );
  const u = rows[0];
  if (!u) return false;
  if (u.email) {
    sendWelcomeEmail(u.email, u.first_name, normalizeLocale(u.locale)).catch((err) =>
      logger.warn({ err }, "[auth] welcome email failed"),
    );
  }
  return true;
}

export type ConsumeResult = { ok: true; userId: string } | { ok: false };

/** Consumă un token din link (o singură dată, neexpirat, pentru adresa curentă a contului). */
export async function consumeEmailVerification(token: string): Promise<ConsumeResult> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { ok: false };
  const { rows } = await dbQuery<{ user_id: string }>(
    `UPDATE email_verification_tokens t SET used_at = now()
       FROM users u
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
        AND u.id = t.user_id AND u.email IS NOT NULL AND lower(u.email) = t.email_lower
        AND COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')
      RETURNING t.user_id`,
    [sha256(token)],
  );
  const userId = rows[0]?.user_id;
  if (!userId) return { ok: false };
  await markEmailVerified(userId);
  return { ok: true, userId };
}
