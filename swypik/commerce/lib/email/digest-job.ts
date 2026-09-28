/**
 * Jobul digestului săptămânal (MARKETING) — rulat de app/api/cron/email-digest.
 *
 * Pleacă DOAR dacă:
 *   - FEATURE_EMAIL_MARKETING e pornit;
 *   - utilizatorul și-a dat consimțământul (notification_preferences.email_marketing
 *     = true, implicit false) și nu a oprit digestul (email_digest);
 *   - emailul e confirmat și adresa nu e în email_unsubscribes.
 * Emailul e în limba utilizatorului, cu footer de dezabonare.
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";
import { logger } from "@/lib/logger";
import { maskEmail } from "./escape";
import { normalizeLocale } from "./i18n";
import { sendDigestEmail, type DigestProduct, type DigestVideo } from "./templates/digest";

const BATCH_SIZE = 50;
const SEND_GAP_MS = 1000;

async function topTrendingProducts(): Promise<DigestProduct[]> {
  const { rows } = await dbQuery<DigestProduct>(
    `SELECT p.id::text, p.title, p.slug, p.image_url, p.price_cents,
            COALESCE(p.currency::text, $1) AS currency
       FROM marketplace_products p
      WHERE p.status = 'active' AND COALESCE(p.is_adult, false) = false
      ORDER BY p.created_at DESC NULLS LAST
      LIMIT 6`,
    [DEFAULT_CURRENCY],
  );
  return rows;
}

async function topVideosFromFollows(userId: string): Promise<DigestVideo[]> {
  try {
    const { rows } = await dbQuery<DigestVideo>(
      `SELECT v.id::text, v.title, u.display_name AS creator_name
         FROM videos v
         JOIN follows f ON f.following_user_id = v.creator_id AND f.follower_user_id = $1
         LEFT JOIN users u ON u.id = v.creator_id
        WHERE v.visibility = 'public' AND v.is_hidden = false
          AND v.status = 'ready' AND v.effective_label = 'safe'
          AND v.published_at >= NOW() - INTERVAL '7 days'
        ORDER BY COALESCE(v.view_count, 0) DESC, v.published_at DESC NULLS LAST
        LIMIT 3`,
      [userId],
    );
    return rows;
  } catch {
    return [];
  }
}

type Candidate = { id: string; email: string; first_name: string | null; locale: string | null };

export async function runDigest(): Promise<{ sent: number; skipped: number; batch: number; disabled?: boolean }> {
  if (!isEnabled("emailMarketing")) return { sent: 0, skipped: 0, batch: 0, disabled: true };

  const { rows: candidates } = await dbQuery<Candidate>(
    `SELECT u.id::text, u.email, u.first_name, u.locale
       FROM users u
       JOIN notification_preferences np ON np.user_id = u.id
      WHERE u.email IS NOT NULL
        AND u.status = 'active'
        AND u.email_verified_at IS NOT NULL
        AND np.email_marketing = true
        AND COALESCE(np.email_digest, true) = true
        AND (u.last_digest_sent_at IS NULL OR u.last_digest_sent_at < NOW() - INTERVAL '6 days')
        AND NOT EXISTS (SELECT 1 FROM email_unsubscribes eu WHERE eu.email_lower = lower(u.email))
      ORDER BY u.last_digest_sent_at NULLS FIRST
      LIMIT $1`,
    [BATCH_SIZE],
  );
  if (candidates.length === 0) return { sent: 0, skipped: 0, batch: 0 };

  const products = await topTrendingProducts();
  let sent = 0;
  let skipped = 0;
  for (const u of candidates) {
    try {
      const videos = await topVideosFromFollows(u.id);
      if (products.length === 0 && videos.length === 0) {
        skipped++;
        continue;
      }
      const ok = await sendDigestEmail({
        to: u.email,
        locale: normalizeLocale(u.locale),
        firstName: u.first_name,
        products,
        videos,
      });
      if (ok) {
        await dbQuery(`UPDATE users SET last_digest_sent_at = NOW() WHERE id = $1`, [u.id]);
        sent++;
      } else {
        skipped++;
      }
    } catch (e) {
      logger.warn({ to: maskEmail(u.email), err: e }, "[email-digest] send failed");
      skipped++;
    }
    await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }
  return { sent, skipped, batch: candidates.length };
}
