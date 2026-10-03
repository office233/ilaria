/**
 * O rulare a pipeline-ului de știri, cu rezultatul înregistrat în `cron_runs`
 * (job 'news-pipeline') ca să fie vizibil în /admin/news — înainte, un
 * pipeline fără chei Azure, fără surse sau cu toate feed-urile căzute apărea
 * doar ca „FAIL” în logurile cron-worker, iar /api/news rămânea gol în tăcere.
 *
 * Folosit de cron (/api/cron/news-pipeline, sincron) și de „Rulează acum” din
 * admin (/api/admin/news/run, în fundal prin `after()` → 202 imediat).
 */
import { dbQuery } from "@/lib/db";
import { cronLockKey, withAdvisoryLock } from "@/lib/cron/lock";
import { logger } from "@/lib/logger";
import { refreshNewsLists } from "@/lib/prewarm/news";
import { runNewsIngestionPipeline, type PipelineResult } from "./rss-ingester";

export const NEWS_JOB = "news-pipeline";

export type NewsRunOutcome =
  | { kind: "skipped" }
  | { kind: "not_configured"; result: PipelineResult }
  | { kind: "no_sources"; result: PipelineResult }
  | { kind: "all_failed"; result: PipelineResult }
  | { kind: "ok"; result: PipelineResult }
  | { kind: "crashed"; error: string };

export type TriggeredBy = "cron" | "admin";

/** Rând 'running' creat la declanșarea din admin (UI-ul îl urmărește până se termină). */
export async function startNewsRun(triggeredBy: TriggeredBy): Promise<string | null> {
  try {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO cron_runs (job_name, status, result) VALUES ($1, 'running', $2::jsonb) RETURNING id::text`,
      [NEWS_JOB, JSON.stringify({ triggeredBy })],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "[news-pipeline] could not record run start");
    return null;
  }
}

function outcomeStatus(o: NewsRunOutcome): "success" | "failed" | "skipped" {
  if (o.kind === "skipped") return "skipped";
  return o.kind === "ok" ? "success" : "failed";
}

async function finishNewsRun(runId: string | null, o: NewsRunOutcome, triggeredBy: TriggeredBy, startedMs: number): Promise<void> {
  const result = "result" in o ? { ...o.result, outcome: o.kind, triggeredBy } : { outcome: o.kind, triggeredBy };
  const error = o.kind === "crashed" ? o.error : o.kind === "ok" || o.kind === "skipped" ? null : o.kind;
  const params = [outcomeStatus(o), Date.now() - startedMs, JSON.stringify(result), error];
  try {
    if (runId) {
      await dbQuery(
        `UPDATE cron_runs SET status = $1, duration_ms = $2, result = $3::jsonb, error = $4, completed_at = now()
          WHERE id = $5::bigint`,
        [...params, runId],
      );
    } else {
      await dbQuery(
        `INSERT INTO cron_runs (job_name, status, duration_ms, result, error, completed_at)
         VALUES ($5, $1, $2, $3::jsonb, $4, now())`,
        [...params, NEWS_JOB],
      );
    }
  } catch (err) {
    logger.warn({ err }, "[news-pipeline] could not record run result");
  }
}

function classify(res: PipelineResult): NewsRunOutcome {
  if (res.reason === "ai_not_configured") return { kind: "not_configured", result: res };
  if (res.reason === "no_sources") return { kind: "no_sources", result: res };
  if (res.ingested === 0 && res.errors > 0) return { kind: "all_failed", result: res };
  return { kind: "ok", result: res };
}

/** Rulează pipeline-ul (exact-once între replici) și înregistrează rezultatul. */
export async function executeNewsPipeline(opts: {
  triggeredBy: TriggeredBy;
  category?: string;
  runId?: string | null;
}): Promise<NewsRunOutcome> {
  const started = Date.now();
  let outcome: NewsRunOutcome;
  try {
    const locked = await withAdvisoryLock(cronLockKey(NEWS_JOB), () => runNewsIngestionPipeline(opts.category));
    outcome = locked.acquired ? classify(locked.value) : { kind: "skipped" };
  } catch (err) {
    logger.error({ err }, "[news-pipeline] run failed");
    outcome = { kind: "crashed", error: err instanceof Error ? err.message.slice(0, 300) : "pipeline_failed" };
  }

  if (outcome.kind === "not_configured") {
    logger.error("[news-pipeline] Azure OpenAI (AZURE_OPENAI_* / NEWS_AI_DEPLOYMENT) missing — nothing ingested");
  } else if (outcome.kind === "no_sources") {
    logger.error("[news-pipeline] no active news_sources — nothing to ingest");
  } else if (outcome.kind === "all_failed") {
    logger.error({ errors: outcome.result.errors, samples: outcome.result.errorSamples }, "[news-pipeline] run produced nothing and had errors");
  } else if (outcome.kind === "ok" && outcome.result.ingested > 0) {
    // Articolele noi apar imediat în lista caldă (lib/prewarm/news.ts).
    await refreshNewsLists().catch((err: unknown) => logger.warn({ err }, "[news-pipeline] warm list refresh failed"));
  }

  // O rulare sărită (lock ținut de alta) nu suprascrie rândul 'running' al altei rulări.
  if (outcome.kind !== "skipped" || opts.runId) await finishNewsRun(opts.runId ?? null, outcome, opts.triggeredBy, started);
  return outcome;
}

export type NewsRunView = {
  id: string;
  status: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: Record<string, unknown> | null;
};

/** Ultimele rulări, pentru cardul de sănătate din /admin/news. */
export async function listRecentNewsRuns(limit = 5): Promise<NewsRunView[]> {
  const { rows } = await dbQuery<{
    id: string; status: string | null; started_at: string; completed_at: string | null;
    duration_ms: number | null; error: string | null; result: Record<string, unknown> | null;
  }>(
    // Un 'running' mai vechi de o oră = procesul a murit înainte să termine.
    `SELECT id::text,
            CASE WHEN status = 'running' AND started_at < now() - interval '1 hour' THEN 'stale' ELSE status END AS status,
            started_at::text, completed_at::text, duration_ms, error, result
       FROM cron_runs WHERE job_name = $1
      ORDER BY started_at DESC LIMIT $2`,
    [NEWS_JOB, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    durationMs: r.duration_ms,
    error: r.error,
    result: r.result,
  }));
}
