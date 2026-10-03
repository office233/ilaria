import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { verifyToken, generateBackupCodes, hashBackupCodes } from "@/lib/auth/totp";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { TwoFactorTokenSchema, parseBody } from "@/lib/validation/schemas";
import { authFail } from "@/lib/auth/api-errors";

export const dynamic = "force-dynamic";

async function POST_impl(req: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("twoFactor", `enable:${session.userId}:${getClientIP(req)}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const rawBody = await req.json().catch(() => null);
  const parsed = parseBody(TwoFactorTokenSchema, rawBody);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const { token } = parsed.data;

  const { rows } = await dbQuery<{ totp_secret: string | null; totp_enabled_at: string | null; has_password: boolean }>(
    `SELECT totp_secret, totp_enabled_at, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1`,
    [session.userId],
  );
  // Fără parolă, dezactivarea 2FA (care cere parola) ar fi imposibilă → blocare.
  if (rows.length > 0 && !rows[0].has_password) return authFail(req, "passwordRequiredFor2fa", 400);
  if (rows.length === 0 || !rows[0].totp_secret) {
    return NextResponse.json({ error: "Inițializează 2FA mai întâi." }, { status: 400 });
  }
  if (rows[0].totp_enabled_at) {
    return NextResponse.json({ error: "2FA este deja activ." }, { status: 400 });
  }
  if (!verifyToken(rows[0].totp_secret, token)) {
    return NextResponse.json({ error: "Cod invalid. Verifică ora telefonului." }, { status: 400 });
  }

  const codes = generateBackupCodes(10);
  const hashed = await hashBackupCodes(codes);
  await dbQuery(
    `UPDATE users SET totp_enabled_at = now(), totp_backup_codes = $1 WHERE id = $2`,
    [hashed, session.userId],
  );

  return NextResponse.json({ success: true, backup_codes: codes });
}

export const POST = withErrorHandling(POST_impl);
