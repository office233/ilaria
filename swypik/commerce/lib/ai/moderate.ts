/**
 * Moderare AI a textului generat de utilizatori — Azure AI Content Safety.
 *
 *   neconfigurat      → flagged=false (decision "not_configured"; euristica locală rămâne)
 *   allow             → flagged=false
 *   review / block    → flagged=true, reasons "sexual:4", …
 *   indisponibil      → flagged=true, reasons ["moderation_unavailable"] (429 F0 după retry,
 *                       timeout, 5xx) → apelantul ține conținutul „pending review”.
 */
import { AzureAIError, analyzeText, isContentSafetyConfigured, safetyVerdict, textThresholds, type SafetyDecision } from "./azure";
import { logger } from "@/lib/logger";

export const MODERATION_UNAVAILABLE = "moderation_unavailable";

export type ModerateDecision = SafetyDecision | "unavailable" | "not_configured";
export type ModerateResult = { flagged: boolean; reasons: string[]; decision: ModerateDecision; maxSeverity: number };

export async function moderate(text: string, feature = "video"): Promise<ModerateResult> {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { flagged: false, reasons: [], decision: "allow", maxSeverity: 0 };
  if (!isContentSafetyConfigured()) return { flagged: false, reasons: [], decision: "not_configured", maxSeverity: 0 };
  try {
    const verdict = safetyVerdict(await analyzeText(trimmed, feature), textThresholds());
    return {
      flagged: verdict.decision !== "allow",
      reasons: verdict.reasons,
      decision: verdict.decision,
      maxSeverity: verdict.maxSeverity,
    };
  } catch (err) {
    logger.warn({ feature, code: err instanceof AzureAIError ? err.code : "unknown" }, "[moderate] content safety unavailable");
    return { flagged: true, reasons: [MODERATION_UNAVAILABLE], decision: "unavailable", maxSeverity: 0 };
  }
}
