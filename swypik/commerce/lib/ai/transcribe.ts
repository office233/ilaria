/**
 * Speech-to-text pentru subtitrări — Azure OpenAI Whisper (`lib/ai/azure`).
 * Neconfigurat / eroare → { text:'', segments:[] }; apelantul (lib/video/captions)
 * transformă asta în „captions_unavailable” (503).
 */
import { AzureAIError, isAzureWhisperConfigured, transcribeAudio, WHISPER_MAX_BYTES } from "./azure";
import { logger } from "@/lib/logger";

export type CaptionSegment = { start: number; end: number; text: string };
export type TranscribeResult = { text: string; segments: CaptionSegment[] };

const EMPTY: TranscribeResult = { text: "", segments: [] };

function mimeFor(filename: string): string {
  if (filename.endsWith(".m4a") || filename.endsWith(".mp4")) return "audio/mp4";
  if (filename.endsWith(".wav")) return "audio/wav";
  return "audio/mpeg";
}

export async function transcribe(audioBuffer: Buffer, lang?: string, filename = "audio.m4a"): Promise<TranscribeResult> {
  if (!isAzureWhisperConfigured()) {
    logger.warn("[transcribe] Azure Whisper not configured → empty");
    return EMPTY;
  }
  if (audioBuffer.length > WHISPER_MAX_BYTES) {
    logger.warn({ bytes: audioBuffer.length }, "[transcribe] audio >25MB → skipped");
    return EMPTY;
  }
  try {
    const out = await transcribeAudio(audioBuffer, {
      feature: "captions",
      language: lang,
      filename,
      mimeType: mimeFor(filename),
    });
    return { text: out.text, segments: out.segments };
  } catch (e) {
    logger.warn({ code: e instanceof AzureAIError ? e.code : "unknown", status: (e as AzureAIError)?.status }, "[transcribe] failed");
    return EMPTY;
  }
}
