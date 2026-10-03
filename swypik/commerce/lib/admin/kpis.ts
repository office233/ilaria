/**
 * Indicatorii dashboard-ului de admin. Fiecare metrică e un query separat,
 * rulate în paralel; o tabelă lipsă/eroare dă `null` pentru metrica aceea,
 * nu pică tot dashboard-ul.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export const KPI_RANGES = ["24h", "7d", "30d"] as const;
export type KpiRange = (typeof KPI_RANGES)[number];

const RANGE_INTERVAL: Record<KpiRange, string> = { "24h": "1 day", "7d": "7 days", "30d": "30 days" };

/** Statusurile unei comenzi încasate (intră în GMV). */
export const PAID_ORDER_STATUSES = ["paid", "fulfilled", "delivered", "return_requested"] as const;

export function parseKpiRange(value: string | undefined | null): KpiRange {
  return (KPI_RANGES as readonly string[]).includes(value ?? "") ? (value as KpiRange) : "7d";
}

export type MoneyTotal = { currency: string; cents: number };

export type AdminKpis = {
  range: KpiRange;
  orders: number | null;
  gmv: MoneyTotal[] | null;
  newUsers: number | null;
  videosPending: number | null;
  videosFlagged: number | null;
  openReports: number | null;
  payoutRequests: { courier: number; creator: number } | null;
  failedJobs: { cron: number; video: number } | null;
};

async function safe<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err, metric: name }, "[admin/kpis] metric failed");
    return null;
  }
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await dbQuery<{ c: string | number }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}

export async function getAdminKpis(range: KpiRange): Promise<AdminKpis> {
  const interval = RANGE_INTERVAL[range];
  const paid = [...PAID_ORDER_STATUSES];

  const [orders, gmv, newUsers, videosPending, videosFlagged, openReports, payoutRequests, failedJobs] =
    await Promise.all([
      safe("orders", () =>
        count(
          `SELECT COUNT(*) AS c FROM commerce_orders
            WHERE created_at >= now() - $1::interval AND status = ANY($2::text[])`,
          [interval, paid],
        ),
      ),
      safe("gmv", async () => {
        const { rows } = await dbQuery<{ currency: string; cents: string }>(
          `SELECT upper(trim(currency)) AS currency, COALESCE(SUM(total_cents), 0)::text AS cents
             FROM commerce_orders
            WHERE created_at >= now() - $1::interval AND status = ANY($2::text[])
            GROUP BY 1 ORDER BY 2 DESC`,
          [interval, paid],
        );
        return rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) }));
      }),
      safe("newUsers", () => count(`SELECT COUNT(*) AS c FROM users WHERE created_at >= now() - $1::interval`, [interval])),
      safe("videosPending", () =>
        count(
          `SELECT COUNT(*) AS c FROM videos
            WHERE moderation_status = 'pending_review' AND COALESCE(status, '') <> 'deleted'`,
        ),
      ),
      safe("videosFlagged", () =>
        count(
          `SELECT COUNT(DISTINCT target_video_id) AS c FROM moderation_cases
            WHERE status IN ('open', 'in_review') AND target_video_id IS NOT NULL`,
        ),
      ),
      safe("openReports", () => count(`SELECT COUNT(*) AS c FROM moderation_reports WHERE status IN ('open', 'triaged')`)),
      safe("payoutRequests", async () => {
        const { rows } = await dbQuery<{ kind: string; c: string }>(
          `SELECT kind, COUNT(*)::text AS c FROM payout_requests
            WHERE status IN ('pending', 'processing') GROUP BY kind`,
        );
        const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.c)]));
        return { courier: by.courier ?? 0, creator: by.creator ?? 0 };
      }),
      safe("failedJobs", async () => {
        const [cron, video] = await Promise.all([
          count(`SELECT COUNT(*) AS c FROM cron_runs WHERE status = 'failed' AND started_at >= now() - $1::interval`, [
            interval,
          ]),
          count(
            `SELECT COUNT(*) AS c FROM video_processing_jobs WHERE status = 'failed' AND updated_at >= now() - $1::interval`,
            [interval],
          ),
        ]);
        return { cron, video };
      }),
    ]);

  return { range, orders, gmv, newUsers, videosPending, videosFlagged, openReports, payoutRequests, failedJobs };
}
