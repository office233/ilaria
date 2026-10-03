/**
 * moderateText — single source of truth for HEURISTIC text moderation across
 * comments / bios / posts / search queries (synchronous, no network).
 * For the AI layer (Azure AI Content Safety) use `moderateUserText` in ./ai-text.
 *
 * Wraps the v2 safety classifier and turns the label into an action that
 * the calling route can apply directly.
 */
import { classifyText, type SafetyLabel, type SafetyResult } from "./classifier";

export type ModerationContext = "comment" | "bio" | "post" | "search" | "display_name";
export type ModerationAction = "allow" | "hide" | "reject";

export type ModerationOutcome = {
  label: SafetyLabel;
  reasons: string[];
  signals: SafetyResult["signals"];
  action: ModerationAction;
  /** User-facing message (RO) explaining a rejection or hide. */
  message?: string;
};

/** Mesajul (RO) pentru o respingere / ascundere, după context și etichetă. */
export function moderationMessage(
  action: ModerationAction,
  ctx: ModerationContext,
  label: SafetyLabel,
): string | undefined {
  if (action === "allow") return undefined;
  if (label === "blocked") return "Conținutul conține termeni interziși și nu poate fi publicat.";
  if (label === "sensitive" && (ctx === "bio" || ctx === "display_name")) {
    return "Conținutul profilului trebuie să fie neutru, fără referințe sugestive.";
  }
  if (action === "hide") return "Mesajul a fost marcat ca explicit și este vizibil doar pentru tine și moderatori.";
  return ctx === "search"
    ? "Termenii de căutare conțin conținut pentru adulți și nu sunt permiși aici."
    : "Acest text conține conținut pentru adulți și nu poate fi publicat pe Swypik.";
}

/**
 * Decide what to do with a piece of user-generated text.
 *
 * Default policy (context-aware):
 *   blocked   → reject everywhere (illegal / hard-block content)
 *   adult     → reject for bio / display_name / search / post titles;
 *               hide for comments (still in DB but status='hidden')
 *   sensitive → reject for bio / display_name; allow elsewhere
 *   safe      → allow
 */
export function moderateText(
  text: string | null | undefined,
  ctx: ModerationContext = "comment",
): ModerationOutcome {
  const input = (text ?? "").trim();
  if (input.length === 0) {
    return { label: "safe", reasons: ["empty"], signals: {}, action: "allow" };
  }

  const result = classifyText({
    title: input,
    description: "",
    category: "",
    tags: [],
  });

  let action: ModerationAction = "allow";
  switch (result.label) {
    case "blocked":
      action = "reject";
      break;
    case "adult":
      action = ctx === "comment" ? "hide" : "reject";
      break;
    case "sensitive":
      action = ctx === "bio" || ctx === "display_name" ? "reject" : "allow";
      break;
    case "safe":
    default:
      action = "allow";
      break;
  }

  return {
    label: result.label,
    reasons: result.reasons,
    signals: result.signals,
    action,
    message: moderationMessage(action, ctx, result.label),
  };
}
