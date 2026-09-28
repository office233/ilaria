import { NextResponse } from "next/server";
import {
  CURRENCY_COOKIE,
  LOCALE_COOKIE,
  isCurrency,
  isLocale,
} from "@/lib/i18n/config";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(req: Request) {
  const rl = await rateLimit("i18n", getClientIP(req));
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: { locale?: string; currency?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true });

  if (body.locale !== undefined) {
    if (!isLocale(body.locale)) {
      return NextResponse.json({ error: "invalid_locale" }, { status: 400 });
    }
    res.cookies.set(LOCALE_COOKIE, body.locale, {
      maxAge: ONE_YEAR,
      path: "/",
      sameSite: "lax",
    });
  }

  if (body.currency !== undefined) {
    if (!isCurrency(body.currency)) {
      return NextResponse.json({ error: "invalid_currency" }, { status: 400 });
    }
    res.cookies.set(CURRENCY_COOKIE, body.currency, {
      maxAge: ONE_YEAR,
      path: "/",
      sameSite: "lax",
    });
  }

  try {
    const auth = await getAuthUser();
    if (auth.userId) {
      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (body.locale !== undefined) { sets.push(`locale = $${i++}`); params.push(body.locale); }
      if (body.currency !== undefined) { sets.push(`preferred_currency = $${i++}`); params.push(body.currency); }
      if (sets.length > 0) {
        params.push(auth.userId);
        await dbQuery(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, params);
      }
    }
  } catch (e: any) {
    logger.warn({ err: e?.message }, "[i18n/preferences] user-profile persist failed");
  }

  return res;
}
