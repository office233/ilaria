import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import bcrypt from "bcryptjs";
import { generateBackupCodes, hashBackupCodes } from "@/lib/auth/totp";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { TwoFactorPasswordSchema, parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

async function POST_impl(req: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("twoFactor", `regen:${session.userId}:${getClientIP(req)}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const rawBody = await req.json().catch(() => null);
  const parsed = parseBody(TwoFactorPasswordSchema, rawBody);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const { password } = parsed.data;

  const { rows } = await dbQuery<{ password_hash: string | null; totp_enabled_at: string | null }>(
    `SELECT password_hash, totp_enabled_at FROM users WHERE id = $1`,
    [session.userId],
  );
  const u = rows[0];
  if (!u) return NextResponse.json({ error: "Cont inexistent." }, { status: 404 });
  if (!u.totp_enabled_at) return NextResponse.json({ error: "2FA nu e activ." }, { status: 400 });
  if (!u.password_hash) return NextResponse.json({ error: "Setează parolă mai întâi." }, { status: 400 });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return NextResponse.json({ error: "Parolă incorectă." }, { status: 401 });

  const codes = generateBackupCodes(10);
  const hashed = await hashBackupCodes(codes);
  await dbQuery(`UPDATE users SET totp_backup_codes = $1 WHERE id = $2`, [hashed, session.userId]);
  return NextResponse.json({ success: true, backup_codes: codes });
}

export const POST = withErrorHandling(POST_impl);
