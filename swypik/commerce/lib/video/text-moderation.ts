/**
 * Moderarea textului care apare PE clip după publicare: subtitrări editate de
 * creator și transcrieri speech-to-text (Whisper). Același filtru ca la
 * publicare (clasificatorul euristic + Azure Content Safety pe text, prin
 * `lib/ai/moderate`); un semnal deschide un caz în coada /admin/moderation și
 * scoate clipul din feed (`moderation_status = 'pending_review'` → trigger-ul
 * din migrarea 0012 face `effective_label = 'pending'`).
 *
 * Content Safety indisponibil (429 F0 / timeout) = semnal: clipul așteaptă un
 * om, la fel ca la publicare. Neconfigurat = doar euristica locală.
 */
import { dbQuery } from "@/lib/db";
import { moderate } from "@/lib/ai/moderate";
import { classifyText } from "@/lib/moderation/classifier";
import { openModerationCase } from "@/lib/moderation/cases";

export type TextModerationKind = "captions" | "speech";

export type TextModerationResult = { held: boolean; reasons: string[] };

/** Limita de text trimis la Content Safety (API-ul acceptă max 10k caractere). */
const MAX_TEXT_CHARS = 10_000;

export async function moderateVideoText(input: {
  videoId: string;
  text: string;
  kind: TextModerationKind;
}): Promise<TextModerationResult> {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return { held: false, reasons: [] };

  const heuristic = classifyText({ title: "", description: text, category: "", tags: [] });
  let reasons: string[] = [];
  let source: "classifier" | "ai_auto" = "classifier";
  if (heuristic.label === "adult" || heuristic.label === "blocked") {
    reasons = heuristic.reasons.length ? heuristic.reasons : [heuristic.label];
  } else {
    const ai = await moderate(text, input.kind === "speech" ? "video-speech" : "video-captions");
    if (ai.flagged) {
      reasons = ai.reasons;
      source = "ai_auto";
    }
  }
  if (reasons.length === 0) return { held: false, reasons };

  await openModerationCase({
    target: { kind: "video", id: input.videoId },
    source,
    reasons,
    metadata: { kind: input.kind, text: text.slice(0, 500) },
  });
  await holdVideo(input.videoId);
  return { held: true, reasons };
}

/** Scoate din feed un clip deja aprobat până decide un moderator (respingerile rămân). */
export async function holdVideo(videoId: string): Promise<void> {
  await dbQuery(
    `UPDATE videos SET moderation_status = 'pending_review', updated_at = NOW()
      WHERE id = $1 AND moderation_status = 'approved'`,
    [videoId],
  );
}
