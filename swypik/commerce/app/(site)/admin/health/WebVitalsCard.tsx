/**
 * Card admin: p75 LCP / INP / CLS per rută, din RUM-ul propriu (lib/perf,
 * POST /api/vitals). Server component — citește agregatele direct din Redis.
 */
import { getTranslations } from "next-intl/server";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { getVitalsSummary, OTHER_ROUTE, type RouteVitals } from "@/lib/perf/vitals-store";
import { rateVital, type VitalRating } from "@/lib/perf/vitals-config";
import { logger } from "@/lib/logger";

const METRICS = ["LCP", "INP", "CLS"] as const;
const TONE: Record<VitalRating, "success" | "warning" | "danger"> = {
  good: "success",
  "needs-improvement": "warning",
  poor: "danger",
};

function formatValue(metric: (typeof METRICS)[number], value: number): string {
  return metric === "CLS" ? value.toFixed(2) : `${Math.round(value)} ms`;
}

async function loadSummary(): Promise<RouteVitals[] | null> {
  try {
    return await getVitalsSummary();
  } catch (err: unknown) {
    logger.warn({ err }, "[admin/health] vitals summary failed");
    return null;
  }
}

export default async function WebVitalsCard() {
  const t = await getTranslations("adminHealth.vitals");
  const rows = await loadSummary();

  return (
    <Card className="mt-6">
      <CardHeader>
        <div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("desc")}</CardDescription>
        </div>
      </CardHeader>
      {rows === null ? (
        <p className="text-sm text-danger">{t("error")}</p>
      ) : rows.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDesc")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 pr-3 font-semibold">{t("route")}</th>
                <th className="py-2 pr-3 font-semibold">{t("samples")}</th>
                {METRICS.map((m) => (
                  <th key={m} className="py-2 pr-3 font-semibold">{t("p75", { metric: m })}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.route} className="border-t border-subtle">
                  <td className="py-2 pr-3 font-mono text-xs text-fg">
                    {row.route === OTHER_ROUTE ? t("otherRoutes") : row.route}
                  </td>
                  <td className="py-2 pr-3 text-muted">{row.samples}</td>
                  {METRICS.map((m) => {
                    const value = row.p75[m];
                    return (
                      <td key={m} className="py-2 pr-3">
                        {value === null ? (
                          <span className="text-subtle">—</span>
                        ) : (
                          <Badge tone={TONE[rateVital(m, value)]}>{formatValue(m, value)}</Badge>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
