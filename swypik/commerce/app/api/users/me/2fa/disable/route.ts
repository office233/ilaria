import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { TwoFactorPasswordSchema, parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

async function POST_impl(req: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("twoFactor", `disable:${session.userId}:${getClientIP(req)}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const rawBody = await req.json().catch(() => null);
  const parsed = parseBody(TwoFactorPasswordSchema, rawBody);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const { password } = parsed.data;

  const { rows } = await dbQuery<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [session.userId],
  );
  if (rows.length === 0 || !rows[0].password_hash) {
    return NextResponse.json({ error: "Nu ai parolă setată." }, { status: 400 });
  }
  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return NextResponse.json({ error: "Parolă incorectă." }, { status: 401 });

  await dbQuery(
    `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_backup_codes = NULL WHERE id = $1`,
    [session.userId],
  );
  return NextResponse.json({ success: true });
}

export const POST = withErrorHandling(POST_impl);
