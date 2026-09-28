/**
 * Dezabonare de la emailurile de marketing.
 *
 *   GET  → NU modifică nimic: redirect la pagina de confirmare /unsubscribe
 *          (scannerele de linkuri din clienții de email deschid orice GET).
 *   POST → dezabonează. Două forme:
 *          - one-click RFC 8058 (antetul List-Unsubscribe): `?u=…&t=…`, răspuns 200 text;
 *          - formularul paginii de confirmare (`form=1`): redirect 303 la /unsubscribe?done=1.
 * Tokenul e HMAC(email), comparat în timp constant. Adresa nu apare în clar în URL-uri noi.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { APP_URL } from "@/lib/app-url";
import { isLocale } from "@/lib/i18n/config";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { decodeEmailParam, encodeEmailParam, verifyUnsubscribeToken } from "@/lib/email/unsubscribe";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type Params = { email: string | null; token: string | null; locale: string | null; form: boolean };

function fromSearch(sp: URLSearchParams): Params {
  return {
    email: decodeEmailParam(sp.get("u")) ?? sp.get("email"),
    token: sp.get("t"),
    locale: sp.get("l"),
    form: sp.get("form") === "1",
  };
}

async function readParams(req: Request): Promise<Params> {
  const p = fromSearch(new URL(req.url).searchParams);
  if (p.email && p.token) return p;
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const f = await req.formData();
      const get = (k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : null);
      return {
        email: decodeEmailParam(get("u")) ?? get("email"),
        token: get("t"),
        locale: get("l"),
        form: get("form") === "1" || p.form,
      };
    }
    if (ct.includes("application/json")) {
      const b = (await req.json()) as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      return { email: decodeEmailParam(s(b.u)) ?? s(b.email), token: s(b.t), locale: s(b.l), form: false };
    }
  } catch {
    // corp malformat — rămânem pe parametrii din URL
  }
  return p;
}

function pageUrl(query: Record<string, string>): string {
  const url = new URL(`${APP_URL}/unsubscribe`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

export async function GET(req: Request) {
  const p = fromSearch(new URL(req.url).searchParams);
  if (!p.email || !p.token) return NextResponse.redirect(pageUrl({ invalid: "1" }), { status: 303 });
  return NextResponse.redirect(
    pageUrl({ u: encodeEmailParam(p.email), t: p.token, ...(isLocale(p.locale) ? { l: p.locale } : {}) }),
    { status: 303 },
  );
}

export async function POST(req: Request) {
  const rl = await rateLimit("unsubscribe", getClientIP(req));
  if (!rl.success) return new NextResponse("Too many requests", { status: 429 });
  const p = await readParams(req);
  const lang: Record<string, string> = isLocale(p.locale) ? { l: p.locale } : {};

  if (!p.email || !p.token || !verifyUnsubscribeToken(p.email, p.token)) {
    return p.form
      ? NextResponse.redirect(pageUrl({ invalid: "1", ...lang }), { status: 303 })
      : new NextResponse("Invalid token", { status: 403 });
  }

  try {
    await dbQuery(
      `INSERT INTO email_unsubscribes(email_lower) VALUES($1) ON CONFLICT (email_lower) DO NOTHING`,
      [p.email.toLowerCase()],
    );
    await dbQuery(
      `UPDATE notification_preferences SET email_marketing = false, updated_at = now()
        WHERE user_id IN (SELECT id FROM users WHERE email IS NOT NULL AND lower(email) = lower($1))`,
      [p.email],
    ).catch((err) => logger.warn({ err }, "[unsubscribe] preference sync failed"));
  } catch (e) {
    logger.error({ err: e }, "[unsubscribe] db error");
    return p.form
      ? NextResponse.redirect(pageUrl({ invalid: "1", ...lang }), { status: 303 })
      : new NextResponse("Server error", { status: 500 });
  }

  if (p.form) return NextResponse.redirect(pageUrl({ done: "1", ...lang }), { status: 303 });
  return new NextResponse("Unsubscribed.", { status: 200, headers: { "Content-Type": "text/plain" } });
}
