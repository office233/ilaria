import { timingSafeEqual } from "node:crypto";

/**
 * Autentificarea declanșatorului de cron (infra/hetzner/cron-worker/run.sh):
 * `Authorization: Bearer <CRON_SECRET>` sau `x-cron-secret`, comparat în timp
 * constant. Fără CRON_SECRET configurat → refuz.
 */
export function isCronAuthorized(req: Request): boolean {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-cron-secret") || "";
    const expected = process.env.CRON_SECRET || "";
    if (!expected || !token || Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
