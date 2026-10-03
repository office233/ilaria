/**
 * Praguri de fraud scoring — unica sursă de adevăr.
 * Override prin env pentru calibrare fără redeploy de cod.
 */
import { intEnv } from "@/lib/config/env";

/** Scor ≥ REVIEW → fraud_review=true + alertă ops. */
export const FRAUD_REVIEW_SCORE = intEnv("FRAUD_REVIEW_SCORE", 50, 1);
/** Scor ≥ BLOCK → fraud_block=true (fulfillment îl sare). */
export const FRAUD_BLOCK_SCORE = intEnv("FRAUD_BLOCK_SCORE", 70, 1);
