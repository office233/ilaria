import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { cronLockKey, cronSkippedResponse, withAdvisoryLock } from "./lock";

export { cronSkippedResponse };

/**
 * Rulează un job de cron cu:
 *  - mutex distribuit (`pg_try_advisory_xact_lock`, vezi `./lock.ts`) → două
 *    declanșări suprapuse ale aceluiași job — de pe orice replică/VM — nu se
 *    calcă (P1-04). Lock-ul se eliberează garantat la COMMIT/ROLLBACK, deci
 *    nu rămâne blocat dacă procesul moare;
 *  - audit-trail în `cron_runs`.
 *
 * Insert-urile în `cron_runs` folosesc `dbQuery` (altă conexiune decât
 * tranzacția-santinelă care ține lock-ul).
 *
 * Returnează `null` când jobul a fost sărit pentru că o altă instanță rula
 * deja. Apelanții TREBUIE să trateze acest caz.
 */
export async function runCron<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const start = Date.now();
  const audit = (status: string, extra: { result?: unknown; error?: string }) =>
    dbQuery(
      "INSERT INTO cron_runs(job_name, status, duration_ms, result, error, completed_at) VALUES($1,$2,$3,$4,$5,NOW())",
      [name, status, Date.now() - start, extra.result === undefined ? null : JSON.stringify(extra.result ?? {}), extra.error ?? null],
    ).catch((err) => logger.warn({ err, job: name }, `[cron] audit-trail insert (${status}) failed`));

  const res = await withAdvisoryLock(cronLockKey(name), async () => {
    try {
      const result = await fn();
      await audit("success", { result: result ?? {} });
      return result;
    } catch (e: unknown) {
      await audit("failed", { error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  });

  if (!res.acquired) {
    logger.warn({ job: name }, "[cron] skipped — another run holds the lock");
    await audit("skipped", { result: { reason: "locked" } });
    return null;
  }
  return res.value;
}
