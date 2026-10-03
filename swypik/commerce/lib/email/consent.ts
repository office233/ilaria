/**
 * Consimțământ pentru marketing: flag-ul global FEATURE_EMAIL_MARKETING +
 * opțiunea explicită a utilizatorului (notification_preferences.email_marketing,
 * implicit false = opt-in). Emailurile tranzacționale NU trec pe aici.
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";

export async function hasMarketingConsent(email: string): Promise<boolean> {
  if (!isEnabled("emailMarketing")) return false;
  try {
    const { rows } = await dbQuery<{ ok: boolean }>(
      `SELECT true AS ok
         FROM users u
         JOIN notification_preferences np ON np.user_id = u.id
        WHERE u.email IS NOT NULL AND lower(u.email) = lower($1)
          AND u.status = 'active'
          AND np.email_marketing = true
          AND NOT EXISTS (SELECT 1 FROM email_unsubscribes eu WHERE eu.email_lower = lower(u.email))
        LIMIT 1`,
      [email],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
