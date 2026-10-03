/**
 * Configurația Azure AI Foundry (EU Data Zone) — singurul furnizor AI al aplicației.
 *
 *   AZURE_OPENAI_ENDPOINT            https://<resource>.openai.azure.com
 *   AZURE_OPENAI_API_KEY             cheia resursei (header `api-key`)
 *   AZURE_OPENAI_CHAT_DEPLOYMENT     deployment chat (ex. gpt-5.4-mini, model de tip reasoning)
 *   AZURE_OPENAI_WHISPER_DEPLOYMENT  deployment Whisper (transcriere, max 25 MB)
 *   AZURE_OPENAI_EMBEDDING_DEPLOYMENT  opțional: text-embedding-3-small (1536 dim)
 *   AZURE_OPENAI_REASONING_EFFORT    opțional: minimal|low|medium|high (netrimis dacă lipsește)
 *   AZURE_CONTENT_SAFETY_ENDPOINT / AZURE_CONTENT_SAFETY_KEY  — moderare text + imagine
 *   CONTENT_SAFETY_{TEXT,IMAGE}_{REVIEW,BLOCK}_AT  — praguri de severitate (0..7)
 *
 * Fiecare getter întoarce null când lipsește ceva → apelanții folosesc calea
 * „neconfigurat” (fallback determinist / fără AI), niciodată o excepție la import.
 */

export type AzureOpenAIConfig = { endpoint: string; apiKey: string };
export type ContentSafetyConfig = { endpoint: string; apiKey: string; apiVersion: string };
export type SeverityThresholds = { reviewAt: number; blockAt: number };
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Versiunea API pentru transcriere (deployments/…/audio/transcriptions). */
export const WHISPER_API_VERSION = "2024-06-01";
/** Limita Azure Whisper pentru fișierul trimis. */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getAzureOpenAIConfig(): AzureOpenAIConfig | null {
  const endpoint = env("AZURE_OPENAI_ENDPOINT");
  const apiKey = env("AZURE_OPENAI_API_KEY");
  if (!endpoint || !apiKey) return null;
  return { endpoint: trimSlash(endpoint), apiKey };
}

export function chatDeployment(): string | null {
  return env("AZURE_OPENAI_CHAT_DEPLOYMENT") || null;
}

export function whisperDeployment(): string | null {
  return env("AZURE_OPENAI_WHISPER_DEPLOYMENT") || null;
}

export function embeddingDeployment(): string | null {
  return env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT") || null;
}

export function reasoningEffort(): ReasoningEffort | null {
  const v = env("AZURE_OPENAI_REASONING_EFFORT").toLowerCase();
  return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : null;
}

export function isAzureChatConfigured(): boolean {
  return getAzureOpenAIConfig() !== null && chatDeployment() !== null;
}

export function isAzureWhisperConfigured(): boolean {
  return getAzureOpenAIConfig() !== null && whisperDeployment() !== null;
}

export function isAzureEmbeddingConfigured(): boolean {
  return getAzureOpenAIConfig() !== null && embeddingDeployment() !== null;
}

export function getContentSafetyConfig(): ContentSafetyConfig | null {
  const endpoint = env("AZURE_CONTENT_SAFETY_ENDPOINT");
  const apiKey = env("AZURE_CONTENT_SAFETY_KEY");
  if (!endpoint || !apiKey) return null;
  return { endpoint: trimSlash(endpoint), apiKey, apiVersion: env("AZURE_CONTENT_SAFETY_API_VERSION") || "2024-09-01" };
}

export function isContentSafetyConfigured(): boolean {
  return getContentSafetyConfig() !== null;
}

function severity(name: string, fallback: number): number {
  const raw = env(name);
  const n = raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 7 ? n : fallback;
}

/** Text: review de la severitate medie (4), blocare la severitate mare (6). */
export function textThresholds(): SeverityThresholds {
  return {
    reviewAt: severity("CONTENT_SAFETY_TEXT_REVIEW_AT", 4),
    blockAt: severity("CONTENT_SAFETY_TEXT_BLOCK_AT", 6),
  };
}

/** Imagine: severitățile sunt 0/2/4/6 — review la 2 (sugestiv), blocare la 4. */
export function imageThresholds(): SeverityThresholds {
  return {
    reviewAt: severity("CONTENT_SAFETY_IMAGE_REVIEW_AT", 2),
    blockAt: severity("CONTENT_SAFETY_IMAGE_BLOCK_AT", 4),
  };
}

function positiveInt(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Timeout-uri și retry-uri (override din env pentru operare). */
export function azureLimits() {
  return {
    chatTimeoutMs: positiveInt("AZURE_AI_CHAT_TIMEOUT_MS", 30_000),
    transcribeTimeoutMs: positiveInt("AZURE_AI_TRANSCRIBE_TIMEOUT_MS", 120_000),
    safetyTimeoutMs: positiveInt("AZURE_AI_SAFETY_TIMEOUT_MS", 10_000),
    maxAttempts: positiveInt("AZURE_AI_MAX_ATTEMPTS", 3),
    /** Un Retry-After mai lung decât atât → renunțăm (nu ținem requestul ocupat). */
    maxRetryWaitMs: positiveInt("AZURE_AI_MAX_RETRY_WAIT_MS", 8_000),
  };
}
