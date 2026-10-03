/**
 * Referral attribution helpers.
 *
 * - `swypik_ref` cookie (90 days) carries the referrer's short code from `/r/[code]`.
 * - `getOrCreateReferralCode(userId)` returns the user's short code (creates lazily).
 * - `attributeOnSignup({ inviteeUserId, req })` is called right after a user is
 *    created. It inspects (1) `swypik_ref` cookie, then (2) `swypik_anon` cookie
 *    (whose anon_sessions row may hint at an earlier exposure). Records a
 *    referral_attributions row if a match exists. Reward credit is deferred
 *    until the invitee performs a qualifying action (see `tryValidateReferral`).
 *
 * Anti-fraud: simple IP/UA hash collision check + recent-signup velocity.
 * `anti_fraud_score < 0.5` → row is created but reward is held (won't dispatch).
 */
import { cookies, headers } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { dbQuery, getDb } from "@/lib/db";

const REF_COOKIE = "swypik_ref";
const REF_MAX_AGE = 60 * 60 * 24 * 90; // 90 days
/** Referrals validate max/zi per referrer (env: REFERRAL_DAILY_CAP). */
const REFERRAL_DAILY_CAP = Number(process.env.REFERRAL_DAILY_CAP) > 0 ? Number(process.env.REFERRAL_DAILY_CAP) : 3;
/** Scor anti-fraud minim pentru validare (env: REFERRAL_MIN_SCORE, 0..1). */
const REFERRAL_MIN_SCORE = Number(process.env.REFERRAL_MIN_SCORE) > 0 ? Number(process.env.REFERRAL_MIN_SCORE) : 0.5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function hashOr(v: string | null | undefined): string | null {
  if (!v) return null;
  return createHash("sha256").update(v).digest("hex").slice(0, 32);
}

function generateCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Set the `swypik_ref` cookie. Called from `/r/[code]` landing route. */
export async function setReferralCookie(code: string): Promise<void> {
  const jar = await cookies();
  jar.set(REF_COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: REF_MAX_AGE,
  });
}

/** Read the `swypik_ref` cookie (if any). */
export async function readReferralCookie(): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(REF_COOKIE)?.value;
  return v && /^[A-Z0-9]{6,12}$/.test(v) ? v : null;
}

/** Ensure the caller has a referral code. Returns the code. */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await dbQuery<{ code: string }>(
    `SELECT code FROM referral_codes WHERE user_id = $1`,
    [userId],
  );
  if (existing.rows[0]?.code) return existing.rows[0].code;

  // Retry on collision (UNIQUE on code).
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    try {
      const inserted = await dbQuery<{ code: string }>(
        `INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
         RETURNING code`,
        [userId, candidate],
      );
      if (inserted.rows[0]?.code) return inserted.rows[0].code;
    } catch (err) {
      const msg = (err as Error).message || "";
      if (!msg.includes("referral_codes_code_unique")) throw err;
    }
  }
  throw new Error("Could not allocate referral code after 5 attempts");
}

interface AttributeArgs {
  inviteeUserId: string;
}

interface AttributeResult {
  attributed: boolean;
  referrerUserId?: string;
  source?: string;
  score?: number;
  reason?: string;
}

/**
 * Called from the signup handler right after the user row is created.
 * Reads cookies + headers (already in async-context via next/headers).
 */
export async function attributeOnSignup({ inviteeUserId }: AttributeArgs): Promise<AttributeResult> {
  const jar = await cookies();
  const hdr = await headers();
  const refCode = jar.get(REF_COOKIE)?.value;
  const anonId = jar.get("swypik_anon")?.value;

  const ip = hdr.get("cf-connecting-ip") || hdr.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ua = hdr.get("user-agent");
  const ipHash = hashOr(ip);
  const uaHash = hashOr(ua);

  // 1. Resolve referrer.
  let referrerUserId: string | null = null;
  let source: "explicit_code" | "anon_cookie" | null = null;
  let code: string | null = null;

  if (refCode && /^[A-Z0-9]{6,12}$/.test(refCode)) {
    const r = await dbQuery<{ user_id: string; code: string }>(
      `SELECT user_id, code FROM referral_codes WHERE code = $1`,
      [refCode],
    );
    if (r.rows[0]) {
      referrerUserId = r.rows[0].user_id;
      code = r.rows[0].code;
      source = "explicit_code";
    }
  }

  if (!referrerUserId && anonId && /^[0-9a-f-]{36}$/i.test(anonId)) {
    // Best-effort: anon_sessions row may carry a known referrer in future versions.
    // For now anon_cookie just establishes presence; if cookie+ref both missing we bail.
  }

  if (!referrerUserId || referrerUserId === inviteeUserId) {
    return { attributed: false, reason: referrerUserId ? "self_ref" : "no_referrer" };
  }

  // 2. Compute anti-fraud score.
  //   - same IP hash as a recent signup attributed to same referrer → -0.5
  //   - same UA hash and IP both match → -0.7
  //   - referrer already used daily cap → score *= 0.4 (still record, won't reward)
  let score = 1.0;
  const fraudSignals: Record<string, unknown> = {};

  if (ipHash) {
    const recentSameIp = await dbQuery<{ c: string; same_ua: string }>(
      `SELECT COUNT(*)::text AS c,
              COUNT(*) FILTER (WHERE $3::text IS NOT NULL AND s.ua_hash = $3)::text AS same_ua
         FROM referral_attributions ra
         JOIN anon_sessions s ON s.became_user_id = ra.invitee_user_id
        WHERE ra.referrer_user_id = $1 AND s.ip_hash = $2
          AND ra.created_at > now() - interval '24 hours'`,
      [referrerUserId, ipHash, uaHash],
    );
    const n = Number(recentSameIp.rows[0]?.c ?? "0");
    const sameUaN = Number(recentSameIp.rows[0]?.same_ua ?? "0");
    if (sameUaN > 0) {
      // Same IP AND same UA as a recent signup for this referrer — stronger signal.
      score -= 0.7;
      fraudSignals.same_ip_and_ua_recent = sameUaN;
    } else if (n > 0) {
      score -= 0.5;
      fraudSignals.same_ip_recent = n;
    }
  }

  const todayValidated = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM referral_attributions
      WHERE referrer_user_id = $1 AND validated_at > date_trunc('day', now())`,
    [referrerUserId],
  );
  const todayN = Number(todayValidated.rows[0]?.c ?? "0");
  if (todayN >= REFERRAL_DAILY_CAP) {
    score *= 0.4;
    fraudSignals.daily_cap_reached = todayN;
  }

  score = Math.max(0, Math.min(1, score));

  // 3. Insert attribution + bind anon_sessions → user.
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO referral_attributions
         (invitee_user_id, referrer_user_id, code, source, anti_fraud_score, fraud_signals)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (invitee_user_id) DO NOTHING`,
      [inviteeUserId, referrerUserId, code ?? "ANON", source ?? "anon_cookie", score, fraudSignals],
    );

    if (anonId && /^[0-9a-f-]{36}$/i.test(anonId)) {
      await client.query(
        `UPDATE anon_sessions SET became_user_id = $1, attributed_at = now()
          WHERE anon_id = $2 AND became_user_id IS NULL`,
        [inviteeUserId, anonId],
      );
      // Backfill ledger ownership (does not award retroactive coins — just attribution).
      await client.query(
        `UPDATE anon_post_votes SET attributed_user_id = $1, attributed_at = now()
          WHERE anon_id = $2 AND attributed_user_id IS NULL`,
        [inviteeUserId, anonId],
      );
      await client.query(
        `UPDATE anon_actions SET attributed_user_id = $1, attributed_at = now()
          WHERE anon_id = $2 AND attributed_user_id IS NULL`,
        [inviteeUserId, anonId],
      );
    }

    await client.query("COMMIT");
    return { attributed: true, referrerUserId, source: source ?? "anon_cookie", score };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    return { attributed: false, reason: (err as Error).message };
  } finally {
    client.release();
  }
}

/**
 * Called after a qualifying invitee action (first authenticated vote, share, etc.).
 * If invitee has an unvalidated attribution with score >= 0.5 and the referrer
 * hasn't reached the daily cap, marks the attribution validated.
 * (Points payout was removed with the SWYP points system.)
 */
export async function tryValidateReferral(inviteeUserId: string, action: string): Promise<boolean> {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const attr = await client.query<{
      referrer_user_id: string;
      anti_fraud_score: string;
      validated_at: Date | null;
    }>(
      `SELECT referrer_user_id, anti_fraud_score, validated_at
         FROM referral_attributions
        WHERE invitee_user_id = $1
        FOR UPDATE`,
      [inviteeUserId],
    );
    const row = attr.rows[0];
    if (!row || row.validated_at) {
      await client.query("COMMIT");
      return false;
    }
    const score = Number(row.anti_fraud_score);
    if (score < REFERRAL_MIN_SCORE) {
      await client.query("COMMIT");
      return false;
    }

    const cap = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM referral_attributions
        WHERE referrer_user_id = $1 AND validated_at > date_trunc('day', now())`,
      [row.referrer_user_id],
    );
    if (Number(cap.rows[0]?.c ?? "0") >= REFERRAL_DAILY_CAP) {
      await client.query("COMMIT");
      return false;
    }

    // Points payout removed with the SWYP points system — validation is tracking-only now.
    await client.query(
      `UPDATE referral_attributions
         SET validated_at = now(),
             validation_action = $1
       WHERE invitee_user_id = $2`,
      [action, inviteeUserId],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    return false;
  } finally {
    client.release();
  }
}
