/**
 * Praguri de fraud scoring — unica sursă de adevăr.
 * Override prin env pentru calibrare fără redeploy de cod.
 */
function intEnv(name: string, def: number): number {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : def;
}

/** Scor ≥ REVIEW → fraud_review=true + alertă ops. */
export const FRAUD_REVIEW_SCORE = intEnv("FRAUD_REVIEW_SCORE", 50);
/** Scor ≥ BLOCK → fraud_block=true (fulfillment îl sare). */
export const FRAUD_BLOCK_SCORE = intEnv("FRAUD_BLOCK_SCORE", 70);
