import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { generateSecret, getOtpAuthUrl, encryptSecret } from "@/lib/auth/totp";
import { rateLimit } from "@/lib/security/rate-limit";
import { authFail } from "@/lib/auth/api-errors";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("twoFactor", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { rows } = await dbQuery<{ email: string; totp_enabled_at: string | null; has_password: boolean }>(
    `SELECT email, totp_enabled_at, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1`,
    [session.userId],
  );
  if (rows.length === 0) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // Un cont fără parolă (doar cod pe email) care pornește TOTP nu trebuie să se
  // poată bloca singur: 2FA se folosește împreună cu parola (dezactivarea o cere).
  if (!rows[0].has_password) return authFail(req, "passwordRequiredFor2fa", 400);
  if (rows[0].totp_enabled_at) {
    return NextResponse.json({ error: "2FA este deja activ. Dezactivează-l mai întâi." }, { status: 400 });
  }

  const secret = generateSecret();
  const otpAuthUrl = getOtpAuthUrl(secret, rows[0].email);
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl, { width: 240, margin: 1 });

  let stored: string;
  try {
    stored = encryptSecret(secret);
  } catch (e) {
    return NextResponse.json(
      { error: "Server lipsește cheie de criptare. Contactează administratorul." },
      { status: 500 },
    );
  }

  await dbQuery(
    `UPDATE users SET totp_secret = $1, totp_enabled_at = NULL WHERE id = $2`,
    [stored, session.userId],
  );

  return NextResponse.json({ secret, otpAuthUrl, qrCodeDataUrl });
}
