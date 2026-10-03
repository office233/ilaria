import { jsonDetail, withLatency, withTimeout, type HealthResult } from "@/lib/health";
import { getVideoQueueMetrics } from "./video-jobs";

/** Pragurile peste care coada e „degraded” (alertă, nu eroare). */
const MAX_DEAD_LETTER = Number(process.env.VIDEO_ALERT_DEAD_LETTER ?? 100);
const MAX_OLDEST_QUEUED_S = Number(process.env.VIDEO_ALERT_OLDEST_QUEUED_S ?? 15 * 60);

/** Coada video în Postgres: backlog, lease-uri expirate (workeri morți), dead-letter. */
export async function checkPgQueue(): Promise<HealthResult> {
  try {
    const { value, latency_ms } = await withLatency(() => withTimeout(getVideoQueueMetrics(), 1_500));
    const degraded =
      value.expired_leases > 0 || value.dead_letter > MAX_DEAD_LETTER || value.oldest_queued_age_s > MAX_OLDEST_QUEUED_S;
    return { status: degraded ? "degraded" : "ok", latency_ms, detail: { backend: "postgres", ...value } };
  } catch (error) {
    return { status: "error", latency_ms: 0, detail: { backend: "postgres", ...jsonDetail(error) } };
  }
}
