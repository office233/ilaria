/**
 * News ingestion pipeline (cron: infra/hetzner/cron-worker/run.sh, every 2h).
 *
 * Real stories only: every article starts from an item of a live RSS feed in
 * news_sources, keeps a link to that original article, and is published only
 * if the AI summary passed the validator in ai-journalist.ts. No AI config,
 * no feed, or a rejected summary → nothing is published (never a template).
 */
import { withAdvisoryLock } from "@/lib/db";
import { logger } from "@/lib/logger";
import { generateAutonomousNewsArticle } from "./ai-journalist";
import { categoryIdForSlug, claimRawItem, insertArticle, markRawItemProcessed } from "./article-store";
import { parseCategoryFilter } from "./categories";
import { getNewsAiConfig, getNewsLimits, getNewsPublishMode, getNewsUserAgent } from "./config";
import { countArticlesPublishedToday } from "./repository";
import { parseFeed, type FeedTopic } from "./rss-parser";
import { loadActiveSources, markSourceFetched, type NewsSource } from "./sources";

export type PipelineResult = {
  /** Articles created (published or queued for review). */
  ingested: number;
  status: "published" | "draft";
  categoriesProcessed: string[];
  capped: boolean;
  /** Feed items skipped because they were already processed (dedupe). */
  duplicates: number;
  /** Feeds that failed + summaries that failed/were rejected. */
  errors: number;
  /** Set when the pipeline could not run at all. */
  reason?: "ai_not_configured" | "no_sources";
  /** Active feeds considered this run. */
  sources: number;
  /** First few failure causes (feed URL + HTTP status, AI rejection…) for /admin/news. */
  errorSamples: string[];
};

const MAX_ERROR_SAMPLES = 5;

function noteError(result: PipelineResult, sample: string): void {
  result.errors++;
  if (result.errorSamples.length < MAX_ERROR_SAMPLES) result.errorSamples.push(sample.slice(0, 200));
}

type FetchOutcome = { topics: FeedTopic[] } | { error: string };

async function fetchSourceTopics(src: NewsSource, limits: ReturnType<typeof getNewsLimits>): Promise<FetchOutcome> {
  try {
    const res = await fetch(src.feedUrl, {
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
      headers: { "User-Agent": getNewsUserAgent(), Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
    });
    if (!res.ok) {
      logger.warn({ feedUrl: src.feedUrl, status: res.status }, "[news] feed fetch failed");
      return { error: `feed_http_${res.status}: ${src.name}` };
    }
    const topics = parseFeed(await res.text(), { category: src.category, source: src.name, sourceId: src.id, limit: limits.itemsPerFeed });
    await markSourceFetched(src.id);
    return { topics };
  } catch (err) {
    logger.warn({ err, feedUrl: src.feedUrl }, "[news] feed unavailable");
    return { error: `feed_unavailable: ${src.name}` };
  }
}

async function runPipeline(targetCategory: string | undefined): Promise<PipelineResult> {
  const status = getNewsPublishMode() === "review" ? "draft" : "published";
  const result: PipelineResult = {
    ingested: 0, status, categoriesProcessed: [], capped: false, duplicates: 0, errors: 0, sources: 0, errorSamples: [],
  };

  const ai = getNewsAiConfig();
  if (!ai) return { ...result, reason: "ai_not_configured" };

  const limits = getNewsLimits();
  const alreadyToday = await countArticlesPublishedToday().catch(() => 0);
  const runCap = Math.min(limits.maxArticlesPerRun, Math.max(0, limits.maxArticlesPerDay - alreadyToday));
  if (runCap <= 0) return { ...result, capped: true };

  const category = parseCategoryFilter(targetCategory);
  const sources = await loadActiveSources(category, limits.maxSourcesPerRun);
  result.sources = sources.length;
  if (sources.length === 0) return { ...result, reason: "no_sources" };
  const topics: FeedTopic[] = [];
  for (const src of sources) {
    const got = await fetchSourceTopics(src, limits);
    if ("topics" in got) topics.push(...got.topics);
    else noteError(result, got.error);
  }

  const categories = new Set<string>();
  for (const topic of topics) {
    if (result.ingested >= runCap) {
      result.capped = true;
      break;
    }
    try {
      const rawItemId = await claimRawItem(topic, limits.maxAttemptsPerItem);
      if (!rawItemId) {
        result.duplicates++;
        continue;
      }
      const generated = await generateAutonomousNewsArticle({ ...topic, categoryHint: topic.category });
      if (!generated) {
        noteError(result, `ai_summary_rejected: ${topic.url}`);
        continue; // stays unprocessed → retried on a later run, up to maxAttemptsPerItem
      }
      const categoryId = await categoryIdForSlug(generated.category_slug);
      const articleId = categoryId ? await insertArticle({ generated, topic, categoryId, status, model: `azure:${ai.deployment}` }) : null;
      await markRawItemProcessed(rawItemId);
      if (!articleId) continue;
      categories.add(generated.category_slug);
      result.ingested++;
    } catch (err) {
      noteError(result, `ingest_error: ${err instanceof Error ? err.message : String(err)}`);
      logger.error({ err, topicUrl: topic.url }, "[news] ingestion error for topic");
    }
  }
  result.categoriesProcessed = Array.from(categories);
  return result;
}

export async function runNewsIngestionPipeline(targetCategory?: string): Promise<PipelineResult> {
  // One run at a time: an overlapping cron/admin trigger waits, then finds the items already processed.
  return withAdvisoryLock("news-ingestion-pipeline", () => runPipeline(targetCategory));
}
