/**
 * Account recreation detection: when a fraud-blocked user signs up again
 * with the same email (normalized), phone, or IP, auto-block the new account
 * and notify ops.
 *
 * Called after every signup path (OTP, OAuth, password).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifyOps } from "@/lib/ops/alerts";
import { APP_URL } from "@/lib/app-url";

const RECENT_IP_WINDOW_HOURS = 24;

/**
 * Normalize an email for matching: lowercase, strip +tag, strip dots for gmail.
 * Returns null if input is invalid.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return null;
  // Strip +tag (everything after first +)
  let cleanLocal = local.split("+")[0];
  // Gmail dots are insignificant
  if (domain === "gmail.com" || domain === "googlemail.com") {
    cleanLocal = cleanLocal.replace(/\./g, "");
  }
  return `${cleanLocal}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

/**
 * Normalize a phone: digits only, last 10 (RO format) or full E.164 digits.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  // Keep last 10 (covers RO mobile 07XX XXX XXX, also strips country code variants)
  return digits.slice(-10);
}

/**
 * Record signup signals for a newly created user.
 * Idempotent: ON CONFLICT DO NOTHING.
 */
export async function recordSignupSignals(args: {
  userId: string;
  email?: string | null;
  phone?: string | null;
  ip?: string | null;
  ipCountry?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const emailNorm = normalizeEmail(args.email);
  const phoneNorm = normalizePhone(args.phone);
  const domain = emailNorm ? emailNorm.split("@")[1] : null;

  await dbQuery(
    `INSERT INTO user_fraud_signals
       (user_id, email_normalized, email_domain, phone_normalized, signup_ip, signup_ip_country, signup_user_agent)
     VALUES ($1, $2, $3, $4, NULLIF($5, '')::inet, NULLIF($6, ''), NULLIF($7, ''))
     ON CONFLICT (user_id) DO NOTHING`,
    [
      args.userId,
      emailNorm,
      domain,
      phoneNorm,
      args.ip || "",
      args.ipCountry || "",
      (args.userAgent || "").slice(0, 500),
    ],
  );
}

type RecreationMatch = {
  blockedUserId: string;
  reason: string;
  signal: "email" | "phone" | "ip";
};

/**
 * Check if these signals match a previously fraud-blocked user.
 * Returns the first match or null.
 */
export async function findRecreationMatch(args: {
  email?: string | null;
  phone?: string | null;
  ip?: string | null;
}): Promise<RecreationMatch | null> {
  const emailNorm = normalizeEmail(args.email);
  const phoneNorm = normalizePhone(args.phone);
  const ip = args.ip || null;

  // Email match (strongest signal — normalized form)
  if (emailNorm) {
    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT ufs.user_id::text FROM user_fraud_signals ufs
        JOIN users u ON u.id = ufs.user_id
       WHERE ufs.email_normalized = $1
         AND (u.metadata->'fraud_user_block'->>'blocked')::boolean = true
       LIMIT 1`,
      [emailNorm],
    );
    if (rows[0]) {
      return {
        blockedUserId: rows[0].user_id,
        signal: "email",
        reason: `Email normalized "${emailNorm}" matches blocked user ${rows[0].user_id.slice(0, 8)}`,
      };
    }
  }

  // Phone match (medium — phones reused legitimately by family, but rare)
  if (phoneNorm) {
    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT ufs.user_id::text FROM user_fraud_signals ufs
        JOIN users u ON u.id = ufs.user_id
       WHERE ufs.phone_normalized = $1
         AND (u.metadata->'fraud_user_block'->>'blocked')::boolean = true
       LIMIT 1`,
      [phoneNorm],
    );
    if (rows[0]) {
      return {
        blockedUserId: rows[0].user_id,
        signal: "phone",
        reason: `Phone "${phoneNorm}" matches blocked user ${rows[0].user_id.slice(0, 8)}`,
      };
    }
  }

  // IP match within recent window (weakest — shared NAT, but combined with timing it's strong)
  if (ip) {
    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT ufs.user_id::text FROM user_fraud_signals ufs
        JOIN users u ON u.id = ufs.user_id
       WHERE ufs.signup_ip = $1::inet
         AND (u.metadata->'fraud_user_block'->>'blocked')::boolean = true
         AND (u.metadata->'fraud_user_block'->>'blocked_at')::timestamptz > now() - interval '${RECENT_IP_WINDOW_HOURS} hours'
       LIMIT 1`,
      [ip],
    );
    if (rows[0]) {
      return {
        blockedUserId: rows[0].user_id,
        signal: "ip",
        reason: `Signup IP "${ip}" matches recently blocked user ${rows[0].user_id.slice(0, 8)} (≤${RECENT_IP_WINDOW_HOURS}h)`,
      };
    }
  }

  return null;
}

/**
 * Full recreation check: record signals, check for match, auto-block if found.
 * Call this after every successful user INSERT.
 * Non-throwing — logs errors but never blocks signup.
 */
export async function checkRecreationAndMaybeBlock(args: {
  userId: string;
  email?: string | null;
  phone?: string | null;
  ip?: string | null;
  ipCountry?: string | null;
  userAgent?: string | null;
  signupPath: "otp_email" | "oauth" | "password";
}): Promise<{ blocked: boolean; signal?: string; reason?: string }> {
  try {
    // 1. Record signals for future detection
    await recordSignupSignals(args);

    // 2. Check for match with existing blocked user
    const match = await findRecreationMatch({
      email: args.email,
      phone: args.phone,
      ip: args.ip,
    });
    if (!match) return { blocked: false };

    // 3. Auto-block the new account
    const block = {
      blocked: true,
      blocked_at: new Date().toISOString(),
      reason: `Auto-block (recreation): ${match.reason}`,
      blocked_by: "auto",
      recreation_signal: match.signal,
      recreation_of: match.blockedUserId,
    };
    await dbQuery(
      `UPDATE users SET metadata = metadata || jsonb_build_object('fraud_user_block', $1::jsonb)
        WHERE id = $2`,
      [JSON.stringify(block), args.userId],
    );
    await dbQuery(
      `INSERT INTO user_fraud_decisions (user_id, action, reason, decided_by)
       VALUES ($1, 'auto_block', $2, 'system')`,
      [args.userId, block.reason],
    );

    logger.warn(
      { newUserId: args.userId, blockedUserId: match.blockedUserId, signal: match.signal, signupPath: args.signupPath },
      "[recreation] auto-blocked new account",
    );

    await notifyOps({
      key: `recreation_block:${args.userId}`,
      severity: "critical",
      title: `Recreation auto-block ${args.userId.slice(0, 8)} (${match.signal})`,
      detail: `${block.reason}\nSignup path: ${args.signupPath}`,
      link: `${APP_URL}/admin/risk?status=paid`,
      payload: { newUserId: args.userId, blockedUserId: match.blockedUserId, signal: match.signal },
      cooldownMin: 30,
    }).catch(() => {});

    return { blocked: true, signal: match.signal, reason: block.reason };
  } catch (e) {
    logger.error({ err: e, userId: args.userId }, "[recreation] check failed");
    return { blocked: false };
  }
}
