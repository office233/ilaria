/**
 * Ratele comerciale ale platformei — configurabile prin env, cu default-uri
 * documentate într-un singur loc (înainte erau literale împrăștiate în cod:
 * order-router.ts avea 0.10, process-payouts avea 0.05).
 *
 * Valorile sunt exprimate în bps (basis points, 1% = 100 bps) pentru a evita
 * erorile de virgulă mobilă la calculele pe bani.
 */

function bpsFromEnv(name: string, defaultBps: number): number {
    const raw = process.env[name];
    if (!raw) return defaultBps;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10000) return defaultBps;
    return Math.round(parsed);
}

/** Comisionul platformei pe vânzările seller-ilor locali (default 10%). */
export const PLATFORM_COMMISSION_BPS = bpsFromEnv("PLATFORM_COMMISSION_BPS", 1000);

/**
 * Comisionul creatorului din vânzările atribuite lui (default 5%). O SINGURĂ
 * variabilă: CREATOR_COMMISSION_BPS (înainte existau două — CREATOR_COMMISSION_BPS
 * pentru pagina de câștiguri și CREATOR_COMMISSION_BPS_RATE pentru cron — care
 * puteau diverge). Numele vechi e citit doar ca fallback.
 */
export const CREATOR_COMMISSION_BPS = process.env.CREATOR_COMMISSION_BPS
  ? bpsFromEnv("CREATOR_COMMISSION_BPS", 500)
  : bpsFromEnv("CREATOR_COMMISSION_BPS_RATE", 500);

/** Aplică un comision exprimat în bps pe o sumă în cenți (rotunjire bancară simplă). */
export function applyBps(amountCents: number, bps: number): number {
    return Math.round((amountCents * bps) / 10000);
}

/**
 * Mobility (Swypik Go — curse și livrări curieri).
 * Fallback-uri când zona de preț nu definește propriile procente
 * (pricing_zones.platform_commission_pct / courier_share_pct).
 */

/** Comisionul standard al platformei pe curse/livrări (default 20%). */
export const MOBILITY_PLATFORM_FEE_BPS = bpsFromEnv("MOBILITY_PLATFORM_FEE_BPS", 2000);

/** Cota curierului/șoferului din tarif (default 80%). */
export const MOBILITY_COURIER_SHARE_BPS = bpsFromEnv("MOBILITY_COURIER_SHARE_BPS", 8000);

/** Buffer de pre-autorizare Stripe peste tariful estimat (default 20%). */
export const MOBILITY_AUTH_BUFFER_BPS = bpsFromEnv("MOBILITY_AUTH_BUFFER_BPS", 2000);

/**
 * Stays (cazări).
 */

/** Comisionul Swypik pe rezervări de cazare (default 10%). */
export const STAYS_COMMISSION_BPS = bpsFromEnv("STAYS_COMMISSION_BPS", 1000);

