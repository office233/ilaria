/**
 * Speech-to-text pe Azure OpenAI Whisper (deployment Standard):
 *   POST {endpoint}/openai/deployments/{whisper}/audio/transcriptions?api-version=2024-06-01
 * Limită 25 MB per fișier (audio.m4a al workerului e mono 16 kHz @ 48 kbps ≈ 0,36 MB/min,
 * deci ~69 min încap într-un singur apel; clipurile au max câteva minute).
 */
import { azureLimits, getAzureOpenAIConfig, whisperDeployment, WHISPER_API_VERSION, WHISPER_MAX_BYTES } from "./config";
import { AzureAIError, azurePost } from "./http";
import { logUsage } from "./usage";

export type TranscriptSegment = { start: number; end: number; text: string };
export type Transcript = { text: string; language: string | null; duration: number; segments: TranscriptSegment[] };

export type TranscribeOptions = {
  feature: string;
  /** ISO-639-1 (ex. "ro"); lipsă → detecție automată. */
  language?: string;
  filename?: string;
  mimeType?: string;
  timeoutMs?: number;
};

type VerboseJson = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
};

function toSegments(raw: VerboseJson["segments"]): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? "").trim() }))
    .filter((s) => s.text && s.end > s.start);
}

export async function transcribeAudio(audio: Uint8Array, opts: TranscribeOptions): Promise<Transcript> {
  const cfg = getAzureOpenAIConfig();
  const deployment = whisperDeployment();
  if (!cfg || !deployment) throw new AzureAIError("not_configured", "Azure Whisper is not configured");
  if (audio.byteLength === 0) throw new AzureAIError("bad_response", "whisper: empty audio");
  if (audio.byteLength > WHISPER_MAX_BYTES) throw new AzureAIError("http", "whisper: audio exceeds 25 MB", 413);

  const form = new FormData();
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append("file", new Blob([bytes], { type: opts.mimeType || "audio/mp4" }), opts.filename || "audio.m4a");
  form.append("response_format", "verbose_json");
  if (opts.language) form.append("language", opts.language);

  const started = Date.now();
  try {
    const res = await azurePost({
      op: "whisper",
      url: `${cfg.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${WHISPER_API_VERSION}`,
      headers: { "api-key": cfg.apiKey },
      body: form,
      timeoutMs: opts.timeoutMs ?? azureLimits().transcribeTimeoutMs,
    });
    const json = (await res.json().catch(() => null)) as VerboseJson | null;
    if (!json) throw new AzureAIError("bad_response", "whisper: invalid JSON");
    const duration = Number(json.duration) || 0;
    logUsage({ op: "whisper", feature: opts.feature, deployment, ms: Date.now() - started, ok: true, audioSeconds: duration });
    return {
      text: String(json.text ?? "").trim(),
      language: typeof json.language === "string" ? json.language : null,
      duration,
      segments: toSegments(json.segments),
    };
  } catch (err) {
    if (err instanceof AzureAIError && err.code !== "bad_response") {
      logUsage({ op: "whisper", feature: opts.feature, deployment, ms: Date.now() - started, ok: false, errorCode: err.code });
    }
    throw err;
  }
}
