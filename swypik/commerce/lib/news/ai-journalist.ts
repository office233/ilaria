import { z } from "zod";
import { logger } from "@/lib/logger";
import { NEWS_CATEGORY_SLUGS, isNewsCategory } from "./categories";
import { getNewsAiConfig, getNewsLimits } from "./config";
import { AzureAIError, chatJson } from "@/lib/ai/azure";
import { buildJournalistMessages, NewsArticleOutputSchema } from "./journalist-prompt";

export interface GeneratedArticle {
  title: string;
  slug: string;
  summary_tldr: string;
  content_markdown: string;
  category_slug: string;
  tags: string[];
  image_search_keywords: string;
  reading_time_minutes: number;
  is_breaking: boolean;
  fact_check_score: number;
  fact_check_notes: string;
}


// Text that looks like the model was hijacked by content inside the
// untrusted RSS block (ignore previous instructions, act as, etc).
const INSTRUCTION_LEAK_RE =
  /\b(ignore\s+(all\s+)?(previous|above)\s+instructions?|disregard\s+(the\s+)?(system|previous)\s+prompt|you\s+are\s+now|act\s+as\s+(a|an)\s|system\s*:\s*|new\s+instructions?\s*:)/i;

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

const GeneratedArticleSchema = z.object({
  title: z.string().trim().min(8).max(160),
  slug: z.string().trim().min(3).max(180).regex(/^[a-z0-9-]+$/, "slug must be lowercase kebab-case"),
  summary_tldr: z.string().trim().min(20).max(1200),
  content_markdown: z.string().trim().min(200).max(20000),
  category_slug: z.enum(NEWS_CATEGORY_SLUGS),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  image_search_keywords: z.string().trim().max(200).default(""),
  reading_time_minutes: z.number().int().min(1).max(30).default(3),
  is_breaking: z.boolean().default(false),
  // Scorul de "fact-check" era inventat de model — nu mai e cerut și nu se afișează.
  fact_check_score: z.number().int().min(0).max(100).default(0),
  fact_check_notes: z.string().trim().max(600).default(""),
});

const DIACRITIC_MARKS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function wordSet(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITIC_MARKS_RE, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Rejects an AI rewrite that reproduces a long verbatim span of the source
 * RSS summary (legal requirement: the rewrite must be a summary, not a copy).
 * Naive but effective: any run of >25 consecutive words shared between the
 * generated content and the raw summary triggers a rejection.
 */
export function hasVerbatimOverlap(generatedText: string, sourceSummary: string, maxRun = 25): boolean {
  const a = wordSet(generatedText);
  const b = wordSet(sourceSummary);
  if (b.length < maxRun) return false;

  const bJoined = ` ${b.join(" ")} `;
  for (let start = 0; start + maxRun <= a.length; start++) {
    const run = a.slice(start, start + maxRun).join(" ");
    if (bJoined.includes(` ${run} `)) return true;
  }
  return false;
}

/**
 * Validates and sanitizes a raw parse of the model's JSON output.
 * Rejects: schema violations, disallowed category, embedded URLs other than
 * the source URL, prompt-injection-looking text, and verbatim copying.
 */
export function validateGeneratedArticle(
  raw: unknown,
  context: { sourceUrl: string; sourceSummary: string }
): { ok: true; data: GeneratedArticle } | { ok: false; reason: string } {
  const parsed = GeneratedArticleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "schema_invalid" };
  }
  const data = parsed.data;

  const combinedText = `${data.title}\n${data.summary_tldr}\n${data.content_markdown}`;

  if (INSTRUCTION_LEAK_RE.test(combinedText)) {
    return { ok: false, reason: "instruction_leak_detected" };
  }

  const foundUrls = combinedText.match(URL_RE) || [];
  const disallowedUrls = foundUrls.filter((u) => !u.startsWith(context.sourceUrl));
  if (disallowedUrls.length > 0) {
    return { ok: false, reason: "unexpected_url_in_output" };
  }

  if (hasVerbatimOverlap(data.content_markdown, context.sourceSummary) ||
      hasVerbatimOverlap(data.summary_tldr, context.sourceSummary)) {
    return { ok: false, reason: "verbatim_copy_detected" };
  }

  return { ok: true, data };
}

export async function generateAutonomousNewsArticle(rawTopic: {
  title: string;
  source: string;
  summary: string;
  url?: string;
  categoryHint?: string;
}): Promise<GeneratedArticle | null> {
  // Deployment din env (NEWS_AI_DEPLOYMENT / AZURE_OPENAI_CHAT_DEPLOYMENT), fără default hardcodat.
  const ai = getNewsAiConfig();
  if (!ai) return null;
  const categoryHint = isNewsCategory(rawTopic.categoryHint) ? rawTopic.categoryHint : NEWS_CATEGORY_SLUGS[0];
  const { aiTimeoutMs } = getNewsLimits();

  try {
    const { data } = await chatJson(buildJournalistMessages(rawTopic, categoryHint), {
      feature: "news",
      deployment: ai.deployment,
      schema: NewsArticleOutputSchema,
      schemaName: "news_article",
      maxCompletionTokens: 6000,
      timeoutMs: aiTimeoutMs,
      // Plafon total per articol (inclusiv retry-uri), ca rularea să încapă în timeout-ul cron.
      signal: AbortSignal.timeout(aiTimeoutMs),
    });

    const validated = validateGeneratedArticle(data, {
      sourceUrl: rawTopic.url || "",
      sourceSummary: rawTopic.summary,
    });
    if (validated.ok) return validated.data;
    logger.warn({ reason: validated.reason, title: rawTopic.title }, "[news] AI output rejected by validator");
  } catch (err) {
    logger.warn({ code: err instanceof AzureAIError ? err.code : "unknown", err }, "[news] AI journalist call failed");
  }

  // Fără articol AI valid NU publicăm nimic: un text generat din șablon ar fi
  // prezentat ca știre reală fără să fie (fost bug: articole fabricate).
  return null;
}
