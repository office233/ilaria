/**
 * POST /api/account/delete — ștergerea contului de către utilizator.
 *
 * Body: { confirm: <username-ul curent>, password?: <parola, dacă are una> }.
 * Sesiune obligatorie (cookie sau Bearer); id-ul vine DOAR din sesiune.
 * Anonimizare + curățare: lib/account/delete-account.ts; politica:
 * docs/privacy/account-deletion.md.
 */
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { deleteAccount, deletionBlocker } from "@/lib/account/delete-account";
import { sendAccountDeletedEmail } from "@/lib/email/templates/auth";
import { localeFromRequest, normalizeLocale, translator } from "@/lib/email/i18n";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { APP_URL } from "@/lib/app-url";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const Body = z.object({
  confirm: z.string().trim().min(1).max(64),
  password: z.string().max(200).optional(),
});

const SESSION_COOKIES = ["swypik_session", "seller_session", "admin_session", "admin_token"];

async function fail(req: Request, code: string, status: number) {
  const t = await translator(localeFromRequest(req), "authEmail.deleteAccount.errors");
  return NextResponse.json({ success: false, code, error: t(code, { email: SUPPORT_EMAIL }) }, { status });
}

export async function POST(req: Request) {
  const session = await getAuthSession();
  if (!session) return fail(req, "unauthorized", 401);

  const rl = await rateLimit("account-delete", session.userId, { limit: 5, window: 900 });
  if (!rl.success) return fail(req, "rateLimited", 429);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(req, "confirmMismatch", 400);

  const { rows } = await dbQuery<{ username: string; email: string | null; role: string; password_hash: string | null }>(
    `SELECT username, email, role, password_hash FROM users WHERE id = $1 AND status <> 'deleted'`,
    [session.userId],
  );
  const user = rows[0];
  if (!user) return fail(req, "unauthorized", 401);

  if (parsed.data.confirm.replace(/^@+/, "").toLowerCase() !== user.username.toLowerCase()) {
    return fail(req, "confirmMismatch", 400);
  }
  if (user.password_hash) {
    const ok = parsed.data.password ? await bcrypt.compare(parsed.data.password, user.password_hash) : false;
    if (!ok) return fail(req, "passwordWrong", 403);
  }

  const blocker = await deletionBlocker(session.userId, user.email, user.role);
  if (blocker) return fail(req, blocker === "admin" ? "adminBlocked" : "sellerBlocked", 409);

  try {
    const result = await deleteAccount(session.userId);
    if (!result.ok) return fail(req, "failed", 409);
    logger.info({ userId: session.userId, cleanupFailed: result.cleanupFailed }, "[account-delete] account deleted");
    if (result.email) {
      sendAccountDeletedEmail(result.email, normalizeLocale(result.locale)).catch((err) =>
        logger.warn({ err }, "[account-delete] confirmation email failed"),
      );
    }
  } catch (err) {
    logger.error({ err, userId: session.userId }, "[account-delete] failed");
    return fail(req, "failed", 500);
  }

  const res = NextResponse.json({ success: true });
  // Sesiunile sunt deja revocate în DB; ștergem și cookie-urile (același Domain ca la login).
  const secure = process.env.NODE_ENV === "production";
  const domain = secure ? new URL(APP_URL).hostname : undefined;
  for (const name of SESSION_COOKIES) {
    res.cookies.set(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure, domain });
  }
  return res;
}
