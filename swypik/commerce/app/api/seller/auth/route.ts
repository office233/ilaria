import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import crypto from "crypto";
import { sendMagicLink } from "@/lib/email/service";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { getRedis } from "@/lib/redis";
import { SellerAuthBodySchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

const COOKIE_NAME = "seller_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const isProd = process.env.NODE_ENV === "production";
const SECURE_FLAG = isProd ? "; Secure" : "";

function hashToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const GENERIC_REQUEST_OK = {
  success: true,
  // Răspuns generic (anti-enumerare): clientul afișează textul tradus.
  code: "code_sent_if_exists",
};

export async function POST(req: Request) {
  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = parseBody(SellerAuthBodySchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: "validation_error", code: "validation_error" }, { status: 400 });
    }
    const { action, email, token } = parsed.data;

    if (action === "login" || action === "request_otp") {
      if (!email) {
        return NextResponse.json(GENERIC_REQUEST_OK);
      }

      const normalizedEmail = email.trim().toLowerCase();
      const ip = getClientIP(req);

      const ipLimit = await rateLimit("seller-otp-ip", ip, { limit: 3, window: 60 });
      if (!ipLimit.success) {
        return NextResponse.json(
          { success: false, error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      const emailLimit = await rateLimit("seller-otp-email", normalizedEmail, { limit: 5, window: 3600 });
      if (!emailLimit.success) {
        return NextResponse.json(
          { success: false, error: "rate_limited_email" },
          { status: 429, headers: { "Retry-After": "3600" } },
        );
      }

      const { rows } = await dbQuery(`SELECT id, status FROM sellers WHERE lower(email) = $1`, [normalizedEmail]);
      const start = Date.now();

      let issued = false;
      if (rows.length > 0 && (rows[0].status === "active" || rows[0].status === "approved")) {
        const sellerId = rows[0].id;
        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpToken = `otp:${otp}`;
        const otpHash = hashToken(otpToken);

        try { await getRedis().del(`seller-otp-attempts:${otpHash}`); } catch { }

        await dbQuery(
          `INSERT INTO seller_sessions (seller_id, token, expires_at, created_at)
           VALUES ($1, $2, now() + interval '15 minutes', now())`,
          [sellerId, otpHash],
        );

        // 2026-08-10 (audit P1): OTP în log DOAR în afara producției — condiția
        // @swypik.test permitea expunerea codului în prod pentru orice email de
        // test. În producție OTP-ul nu apare niciodată în loguri.
        if (!isProd) {
          logger.warn({ to: normalizedEmail.replace(/(.{2}).*@/, "$1***@"), otp }, "[SELLER OTP] dev mode code");
        }
        sendMagicLink(normalizedEmail, otp).catch((e) =>
          logger.warn({ err: e?.message }, "[Seller Auth] email send failed"),
        );
        issued = true;
      }

      const elapsed = Date.now() - start;
      if (elapsed < 150) await new Promise((r) => setTimeout(r, 150 - elapsed));
      void issued;
      return NextResponse.json(GENERIC_REQUEST_OK);
    }

    if (action === "verify_otp") {
      if (!email || !token) {
        return NextResponse.json({ success: false, error: "missing_fields" }, { status: 400 });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const otpToken = `otp:${token}`;
      const otpHash = hashToken(otpToken);

      const ip = getClientIP(req);
      const broad = await rateLimit("seller-otp-verify-ip", ip, { limit: 20, window: 300 });
      if (!broad.success) {
        return NextResponse.json(
          { success: false, error: "too_many_attempts" },
          { status: 429, headers: { "Retry-After": "300" } },
        );
      }

      const attemptsKey = `seller-otp-attempts:${otpHash}`;
      let attempts = 0;
      try {
        attempts = await getRedis().incr(attemptsKey);
        if (attempts === 1) await getRedis().expire(attemptsKey, 900);
      } catch (err) {
        // Redis indisponibil: nu putem rate-limita per-OTP. Fail-safe: logăm
        // și tratăm ca prima încercare (rate-limit pe IP e deja aplicat mai sus).
        logger.warn({ err }, "seller.auth: contorul de încercări OTP (Redis) a eșuat");
      }
      if (attempts > 5) {
        await dbQuery(`DELETE FROM seller_sessions WHERE token = $1`, [otpHash]).catch(() => { });
        return NextResponse.json(
          { success: false, error: "otp_locked" },
          { status: 429 },
        );
      }

      const { rows: candidates } = await dbQuery<{ seller_id: string; token: string }>(
        `SELECT ss.seller_id, ss.token
         FROM seller_sessions ss
         JOIN sellers s ON s.id = ss.seller_id
         WHERE lower(s.email) = $1 AND ss.expires_at > now() AND length(ss.token) = 64`,
        [normalizedEmail],
      );

      let matchedSellerId: string | null = null;
      for (const c of candidates) {
        if (timingSafeEqualStr(c.token, otpHash)) {
          matchedSellerId = c.seller_id;
          break;
        }
      }

      if (!matchedSellerId) {
        return NextResponse.json({ success: false, error: "invalid_code" }, { status: 400 });
      }

      await dbQuery(`DELETE FROM seller_sessions WHERE token = $1`, [otpHash]);
      try { await getRedis().del(attemptsKey); } catch { }

      const sessionToken = crypto.randomBytes(32).toString("hex");
      const sessionHash = hashToken(sessionToken);
      await dbQuery(
        `INSERT INTO seller_sessions (seller_id, token, expires_at, created_at)
         VALUES ($1, $2, now() + interval '30 days', now())`,
        [matchedSellerId, sessionHash],
      );

      const response = NextResponse.json({ success: true, sellerId: matchedSellerId });
      response.headers.set(
        "Set-Cookie",
        `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${SECURE_FLAG}`,
      );
      return response;
    }

    return NextResponse.json({ success: false, error: "unknown_action" }, { status: 400 });
  } catch (error: any) {
    logger.error({ err: error }, "[Seller Auth API] Error:");
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
