/**
 * Ștergerea contului din aplicație (App Store 5.1.1(v), Google Play „Account
 * deletion", GDPR art. 17). Politica completă: docs/privacy/account-deletion.md.
 *
 *  - Rândul din `users` NU se șterge fizic (comenzile, facturile, plățile și
 *    comisioanele îl referă și trebuie păstrate de lege), ci se ANONIMIZEAZĂ:
 *    email, nume, telefon, avatar, bio, parolă, 2FA, metadata → șterse;
 *    username → `deleted_<id>`; status 'deleted' + deleted_at.
 *  - Vechiul username rămâne rezervat (alias) ca nimeni să nu preia /u/<nume>.
 *  - Sesiunile se revocă; datele personale din tabelele satelit se șterg
 *    (best-effort, fiecare separat: un tabel lipsă nu blochează ștergerea).
 *  - Conținutul public (clipuri, comentarii, mesaje) e ascuns/șters logic.
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordUsernameAlias } from "@/lib/social/username";

export type DeleteBlocker = "admin" | "activeSeller";

/** Conturi care nu se pot șterge din aplicație (au obligații de business). */
export async function deletionBlocker(userId: string, email: string | null, role: string): Promise<DeleteBlocker | null> {
  if (role === "admin") return "admin";
  if (!email) return null;
  const { rows } = await dbQuery<{ ok: boolean }>(
    `SELECT true AS ok FROM sellers WHERE lower(email) = lower($1) AND status IN ('active', 'approved') LIMIT 1`,
    [email],
  ).catch(() => ({ rows: [] as { ok: boolean }[] }));
  return rows.length ? "activeSeller" : null;
}

/** Curățări fără valoare legală de păstrare. Ordinea contează doar pentru FK-uri. */
const CLEANUP: [string, string][] = [
  ["addresses", `DELETE FROM user_addresses WHERE user_id = $1`],
  ["push_subscriptions", `DELETE FROM push_subscriptions WHERE user_id = $1`],
  ["push_tokens", `DELETE FROM user_push_tokens WHERE user_id = $1`],
  ["oauth", `DELETE FROM oauth_accounts WHERE user_id = $1`],
  ["notification_preferences", `DELETE FROM notification_preferences WHERE user_id = $1`],
  ["notifications", `DELETE FROM notifications WHERE user_id = $1`],
  ["interests", `DELETE FROM user_interests WHERE user_id = $1`],
  ["feed_state", `DELETE FROM user_feed_state WHERE user_id = $1`],
  ["hidden_videos", `DELETE FROM user_hidden_videos WHERE user_id = $1`],
  ["likes", `DELETE FROM likes WHERE user_id = $1`],
  ["saves", `DELETE FROM saves WHERE user_id = $1`],
  ["saved_products", `DELETE FROM saved_products WHERE user_id = $1`],
  ["collection_items", `DELETE FROM user_collection_items WHERE collection_id IN (SELECT id FROM user_collections WHERE user_id = $1)`],
  ["collections", `DELETE FROM user_collections WHERE user_id = $1`],
  ["follows", `DELETE FROM follows WHERE follower_user_id = $1 OR following_user_id = $1`],
  ["blocks", `DELETE FROM user_blocks WHERE blocker_user_id = $1 OR blocked_user_id = $1`],
  ["reviews", `DELETE FROM product_reviews WHERE user_id = $1`],
  ["age_verifications", `DELETE FROM user_age_verifications WHERE user_id = $1`],
  ["verify_tokens", `DELETE FROM email_verification_tokens WHERE user_id = $1`],
  ["reset_tokens", `DELETE FROM password_reset_tokens WHERE user_id = $1`],
  ["cart_items", `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1 AND status <> 'ordered')`],
  ["carts", `DELETE FROM carts WHERE user_id = $1 AND status <> 'ordered'`],
  ["comments", `UPDATE comments SET status = 'deleted', body = '-' WHERE user_id = $1`],
  ["messages", `UPDATE messages SET status = 'deleted', body = '-' WHERE sender_id = $1`],
  ["videos", `UPDATE videos SET status = 'deleted', visibility = 'private', is_hidden = true, updated_at = now() WHERE creator_id = $1`],
];

export type DeleteResult = { ok: true; email: string | null; locale: string | null; cleanupFailed: string[] } | { ok: false };

export async function deleteAccount(userId: string): Promise<DeleteResult> {
  const core = await withTransaction(async (q) => {
    const { rows } = await q<{ email: string | null; username: string; locale: string | null }>(
      `SELECT email, username, locale FROM users WHERE id = $1 AND status <> 'deleted' FOR UPDATE`,
      [userId],
    );
    const u = rows[0];
    if (!u) return null;
    const placeholder = `deleted_${userId.replace(/-/g, "").slice(0, 16)}`;
    await recordUsernameAlias(q, userId, u.username, placeholder);
    await q(
      `UPDATE users SET
         email = NULL, external_auth_id = NULL, username = $2, display_name = NULL,
         first_name = NULL, last_name = NULL, phone = NULL, phone_verified_at = NULL,
         avatar_url = NULL, bio = NULL, birth_date = NULL,
         password_hash = NULL, password_set_at = NULL,
         totp_secret = NULL, totp_enabled_at = NULL, totp_backup_codes = NULL,
         auth_providers = ARRAY[]::text[], metadata = '{}'::jsonb,
         adult_content_opt_in = false, liked_videos_public = false,
         status = 'deleted', deleted_at = now(), last_seen_at = NULL, updated_at = now()
       WHERE id = $1`,
      [userId, placeholder],
    );
    await q(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    return u;
  });
  if (!core) return { ok: false };

  const cleanupFailed: string[] = [];
  for (const [name, sql] of CLEANUP) {
    try {
      await dbQuery(sql, [userId]);
    } catch (err) {
      cleanupFailed.push(name);
      logger.warn({ err, userId, step: name }, "[account-delete] cleanup step failed");
    }
  }
  await dbQuery(`DELETE FROM admin_sessions WHERE user_id = $1`, [userId]).catch(() => undefined);
  return { ok: true, email: core.email, locale: core.locale, cleanupFailed };
}
