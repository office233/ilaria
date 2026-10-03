/**
 * Azure AI Content Safety (api-version 2024-09-01): text:analyze + image:analyze.
 * Categorii Hate / SelfHarm / Sexual / Violence, severități 0..7 (text, FourSeverityLevels
 * → 0/2/4/6) și 0/2/4/6 (imagine). F0 are limită de rată → 429 cu Retry-After,
 * tratat de `azurePost`; dacă tot eșuează, apelantul degradează la „pending review”.
 */
import { azureLimits, getContentSafetyConfig, type SeverityThresholds } from "./config";
import { AzureAIError, azurePost } from "./http";
import { logUsage } from "./usage";

export const SAFETY_CATEGORIES = ["Hate", "SelfHarm", "Sexual", "Violence"] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];
export type SafetyScores = Record<SafetyCategory, number>;
export type SafetyDecision = "allow" | "review" | "block";

/** Limita serviciului pentru text:analyze. */
export const SAFETY_TEXT_MAX_CHARS = 10_000;
/** Limita serviciului pentru image:analyze (după base64 e ~5,3 MB). */
export const SAFETY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

type AnalyzeResponse = { categoriesAnalysis?: Array<{ category?: unknown; severity?: unknown }> };

function emptyScores(): SafetyScores {
  return { Hate: 0, SelfHarm: 0, Sexual: 0, Violence: 0 };
}

function toScores(json: AnalyzeResponse | null): SafetyScores {
  const scores = emptyScores();
  for (const item of json?.categoriesAnalysis ?? []) {
    const cat = SAFETY_CATEGORIES.find((c) => c === item.category);
    const sev = Number(item.severity);
    if (cat && Number.isFinite(sev)) scores[cat] = Math.max(0, Math.min(7, Math.trunc(sev)));
  }
  return scores;
}

async function analyze(kind: "text" | "image", feature: string, payload: unknown): Promise<SafetyScores> {
  const cfg = getContentSafetyConfig();
  if (!cfg) throw new AzureAIError("not_configured", "Azure Content Safety is not configured");
  const op = `safety.${kind}`;
  const started = Date.now();
  try {
    const res = await azurePost({
      op,
      url: `${cfg.endpoint}/contentsafety/${kind}:analyze?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": cfg.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: azureLimits().safetyTimeoutMs,
    });
    const scores = toScores((await res.json().catch(() => null)) as AnalyzeResponse | null);
    logUsage({ op, feature, ms: Date.now() - started, ok: true });
    return scores;
  } catch (err) {
    const code = err instanceof AzureAIError ? err.code : "network";
    logUsage({ op, feature, ms: Date.now() - started, ok: false, errorCode: code });
    throw err;
  }
}

export function analyzeText(text: string, feature: string): Promise<SafetyScores> {
  const clipped = text.slice(0, SAFETY_TEXT_MAX_CHARS);
  return analyze("text", feature, { text: clipped, categories: [...SAFETY_CATEGORIES], outputType: "FourSeverityLevels" });
}

export function analyzeImage(image: Uint8Array, feature: string): Promise<SafetyScores> {
  if (image.byteLength > SAFETY_IMAGE_MAX_BYTES) {
    return Promise.reject(new AzureAIError("http", "safety.image: image exceeds 4 MB", 413));
  }
  return analyze("image", feature, {
    image: { content: Buffer.from(image).toString("base64") },
    categories: [...SAFETY_CATEGORIES],
    outputType: "FourSeverityLevels",
  });
}

export type SafetyVerdict = { decision: SafetyDecision; reasons: string[]; maxSeverity: number };

/** Mapare scoruri → decizie cu praguri din config. Motivele: "sexual:4". */
export function safetyVerdict(scores: SafetyScores, thresholds: SeverityThresholds): SafetyVerdict {
  let maxSeverity = 0;
  const reasons: string[] = [];
  for (const cat of SAFETY_CATEGORIES) {
    const sev = scores[cat];
    maxSeverity = Math.max(maxSeverity, sev);
    if (sev >= thresholds.reviewAt) reasons.push(`${cat.toLowerCase()}:${sev}`);
  }
  const decision: SafetyDecision =
    maxSeverity >= thresholds.blockAt ? "block" : maxSeverity >= thresholds.reviewAt ? "review" : "allow";
  return { decision, reasons, maxSeverity };
}
