/**
 * Filtru pe ieșirea asistentului de shopping (/api/chat) — Azure AI Content Safety.
 * Răspunsul modelului trece deja prin filtrul de conținut al Azure OpenAI; aici
 * blocăm orice ajunge la pragul de review. La indisponibilitate (429/timeout)
 * lăsăm răspunsul să treacă (fail-open) — chatul nu are coadă de review.
 */
import { moderate } from "./moderate";

export type ModerationResult = { safe: boolean; reason: string };

export async function moderateOutput(text: string): Promise<ModerationResult> {
  const trimmed = String(text || "").slice(0, 8_000);
  if (!trimmed.trim()) return { safe: true, reason: "empty" };
  const result = await moderate(trimmed, "shop-chat-output");
  switch (result.decision) {
    case "not_configured":
      return { safe: true, reason: "no-provider" };
    case "unavailable":
      return { safe: true, reason: "moderation-unavailable" };
    case "allow":
      return { safe: true, reason: "ok" };
    default:
      return { safe: false, reason: result.reasons.join(",") || result.decision };
  }
}
