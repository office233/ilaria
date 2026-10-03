/**
 * moderateUserText — euristica locală (`moderateText`) + Azure AI Content Safety.
 *
 * Euristica rulează prima (gratuit, sincron); dacă ea respinge deja, nu mai apelăm
 * AI-ul. Maparea verdictului AI (praguri din CONTENT_SAFETY_TEXT_*):
 *   block  → reject peste tot
 *   review → comment: hide (status 'hidden' + caz de moderare); bio / display_name / post: reject
 *   indisponibil (429 F0, timeout) → comment: hide „pending review” (fără strike);
 *                                   bio / display_name / post: allow (euristica a trecut)
 * Căutarea (`search`) nu apelează AI-ul (volum mare, F0 are limită de rată).
 */
import { moderate } from "@/lib/ai/moderate";
import { moderateText, moderationMessage, type ModerationContext, type ModerationOutcome } from "./moderateText";

export type AiModerationOutcome = ModerationOutcome & {
  /** true = decizia vine din indisponibilitatea AI-ului, nu din conținut → fără strike. */
  degraded: boolean;
  /** Verdictul AI a contribuit la decizie. */
  ai: boolean;
};

export async function moderateUserText(
  text: string | null | undefined,
  ctx: ModerationContext = "comment",
): Promise<AiModerationOutcome> {
  const base = moderateText(text, ctx);
  const input = (text ?? "").trim();
  if (base.action === "reject" || !input || ctx === "search") return { ...base, degraded: false, ai: false };

  const ai = await moderate(input, `text.${ctx}`);
  if (ai.decision === "allow" || ai.decision === "not_configured") return { ...base, degraded: false, ai: false };

  // Motivele euristicii contează doar dacă ea a semnalat ceva (altfel e doar "safe").
  const reasons = [...(base.label === "safe" ? [] : base.reasons), ...ai.reasons];
  if (ai.decision === "unavailable") {
    if (ctx !== "comment") return { ...base, degraded: true, ai: false };
    return { ...base, action: "hide", reasons, degraded: true, ai: true, message: undefined };
  }

  if (ai.decision === "block") {
    return { ...base, label: "blocked", reasons, action: "reject", message: moderationMessage("reject", ctx, "blocked"), degraded: false, ai: true };
  }
  const action = ctx === "comment" ? "hide" : "reject";
  const label = base.label === "safe" ? "sensitive" : base.label;
  return { ...base, label, reasons, action, message: moderationMessage(action, ctx, "adult"), degraded: false, ai: true };
}
