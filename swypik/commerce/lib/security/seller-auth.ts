import { dbQuery } from "@/lib/db";
import { cookies } from "next/headers";
import crypto from "crypto";
import { isSessionTokenFormat } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

const COOKIE_NAME = "seller_session";

function hashToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function getSellerSessionId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    // OTP-urile de seller stau in ACEEASI tabela `seller_sessions`, cu
    // token = sha256("otp:" + cod). Un cookie `seller_session=otp:123456`
    // producea exact acel hash => acces la portalul sellerului cu ~10^6
    // incercari, fara contor (audit 2026-08-25). Token-urile reale sunt
    // randomBytes(32).toString("hex") = 64 hex, deci garda de format le
    // pastreaza intacte si blocheaza forma de OTP.
    if (!isSessionTokenFormat(token)) return null;

    // Statusul seller-ului se re-verifică la fiecare cerere: un seller suspendat
    // sau respins pierde accesul imediat, nu după expirarea sesiunii (30 zile).
    const { rows } = await dbQuery(
      `SELECT ss.seller_id
         FROM seller_sessions ss
         JOIN sellers s ON s.id = ss.seller_id
        WHERE ss.token = $1 AND ss.expires_at > now() AND s.status IN ('approved', 'active')`,
      [hashToken(token)]
    );

    if (rows.length === 0) return null;
    return rows[0].seller_id;
  } catch (error) {
    logger.error({ err: error }, "[Seller Auth] Error reading session");
    return null;
  }
}
