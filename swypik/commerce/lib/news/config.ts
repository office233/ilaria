/**
 * Swypik News runtime configuration — everything tunable comes from env.
 *
 *   AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY   required (lib/ai/azure)
 *   NEWS_AI_DEPLOYMENT      Azure chat deployment for the journalist; falls back to
 *                           AZURE_OPENAI_CHAT_DEPLOYMENT — no hardcoded default: an
 *                           unset deployment = pipeline off
 *   NEWS_PUBLISH_MODE       "auto" (default) publishes validated summaries;
 *                           "review" stores them as drafts for /admin/news
 *   NEWS_MAX_ARTICLES_PER_RUN / _PER_DAY, NEWS_MAX_SOURCES_PER_RUN,
 *   NEWS_ITEMS_PER_FEED, NEWS_FETCH_TIMEOUT_MS, NEWS_AI_TIMEOUT_MS,
 *   NEWS_MAX_ATTEMPTS_PER_ITEM, NEWS_BOT_USER_AGENT
 */
import { APP_URL } from "@/lib/app-url";
import { chatDeployment, getAzureOpenAIConfig } from "@/lib/ai/azure/config";

function positiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export type NewsAiConfig = { deployment: string };

/** Null when the AI journalist can't run (Azure OpenAI or deployment missing). */
export function getNewsAiConfig(): NewsAiConfig | null {
  if (!getAzureOpenAIConfig()) return null;
  const deployment = (process.env.NEWS_AI_DEPLOYMENT || chatDeployment() || "").trim();
  return deployment ? { deployment } : null;
}

export type NewsPublishMode = "auto" | "review";

export function getNewsPublishMode(): NewsPublishMode {
  return process.env.NEWS_PUBLISH_MODE?.trim().toLowerCase() === "review" ? "review" : "auto";
}

export function getNewsLimits() {
  return {
    // 8 × NEWS_AI_TIMEOUT_MS (20s, total per article incl. retries) + feeds stays
    // under the cron-worker 300s curl timeout.
    maxArticlesPerRun: positiveInt("NEWS_MAX_ARTICLES_PER_RUN", 8),
    maxArticlesPerDay: positiveInt("NEWS_MAX_ARTICLES_PER_DAY", 60),
    maxSourcesPerRun: positiveInt("NEWS_MAX_SOURCES_PER_RUN", 8),
    itemsPerFeed: positiveInt("NEWS_ITEMS_PER_FEED", 3),
    fetchTimeoutMs: positiveInt("NEWS_FETCH_TIMEOUT_MS", 5_000),
    aiTimeoutMs: positiveInt("NEWS_AI_TIMEOUT_MS", 20_000),
    maxAttemptsPerItem: positiveInt("NEWS_MAX_ATTEMPTS_PER_ITEM", 3),
  };
}

export function getNewsUserAgent(): string {
  return process.env.NEWS_BOT_USER_AGENT?.trim() || `SwypikNewsBot/2.0 (+${APP_URL})`;
}

/** Public page size for /api/news and the news feed cards. */
export const NEWS_PAGE_SIZE = 20;
export const NEWS_MAX_PAGE_SIZE = 50;
