"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

export type NewsRun = {
  id: string;
  status: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: { outcome?: string; ingested?: number; errors?: number; sources?: number; errorSamples?: string[]; triggeredBy?: string } | null;
};

export type NewsHealth = {
  activeSources: number;
  drafts: number;
  published: number;
  publishedLast24h: number;
  runs: NewsRun[];
};

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE: Record<string, BadgeTone> = { success: "success", failed: "danger", running: "info", skipped: "neutral", stale: "warning" };
const KNOWN_OUTCOMES = new Set(["ok", "not_configured", "no_sources", "all_failed", "crashed", "skipped"]);
const KNOWN_STATUSES = new Set(Object.keys(TONE));

/** De ce e /api/news gol: surse, ultimele rulări (din cron_runs) și cauza eșecurilor. */
export default function PipelineHealthCard({ health }: { health: NewsHealth }) {
  const t = useTranslations("adminNews.health");
  const format = useFormatter();
  const last = health.runs[0];

  return (
    <Card className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Activity className="h-4 w-4" aria-hidden /> {t("title")}
      </h2>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {(["activeSources", "published", "publishedLast24h", "drafts"] as const).map((k) => (
          <div key={k} className="rounded-control bg-surface-2 p-2">
            <dt className="text-xs text-muted">{t(k)}</dt>
            <dd className="text-base font-semibold tabular-nums text-fg">{health[k]}</dd>
          </div>
        ))}
      </dl>
      {health.activeSources === 0 ? <p className="text-sm text-warning">{t("noSources")}</p> : null}
      {!last ? (
        <p className="text-sm text-muted">{t("neverRan")}</p>
      ) : (
        <ul className="space-y-2">
          {health.runs.map((run) => {
            const status = run.status && KNOWN_STATUSES.has(run.status) ? run.status : "failed";
            const outcome = run.result?.outcome && KNOWN_OUTCOMES.has(run.result.outcome) ? run.result.outcome : null;
            return (
              <li key={run.id} className="rounded-control border border-subtle p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[status]}>{t(`status.${status}`)}</Badge>
                  <span className="text-muted">
                    {format.dateTime(new Date(run.startedAt), { dateStyle: "short", timeStyle: "short" })}
                  </span>
                  {run.result?.triggeredBy === "admin" ? <span className="text-xs text-muted">{t("manual")}</span> : null}
                  {typeof run.result?.ingested === "number" ? (
                    <span className="ml-auto text-muted">{t("ingested", { count: run.result.ingested })}</span>
                  ) : null}
                </div>
                {outcome && outcome !== "ok" ? <p className="mt-1 text-danger">{t(`outcome.${outcome}`)}</p> : null}
                {run.result?.errorSamples?.length ? (
                  <ul className="mt-1 list-inside list-disc break-all text-xs text-muted">
                    {run.result.errorSamples.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
