/**
 * Mutex distribuit pe Postgres pentru joburi programate și bucle de fundal.
 *
 * Cu N replici web, un cron poate ajunge de mai multe ori (două cron-workere
 * pornite din greșeală, un retry al declanșatorului, dispatch-worker pe două
 * VM-uri). `pg_try_advisory_xact_lock` NU blochează: exact o execuție ține
 * lock-ul, celelalte primesc `{ acquired: false }` imediat și ies (200 skipped).
 * Lock-ul e legat de tranzacția-santinelă → eliberat garantat la COMMIT/ROLLBACK
 * sau dacă procesul/conexiunea moare (nu rămâne niciodată „agățat”).
 *
 * Tranzacția-santinelă ține doar lock-ul; scrierile jobului merg pe alte
 * conexiuni din pool (prin `dbQuery`). Postgres e partajat de toate replicile,
 * deci lock-ul e global, indiferent de VM.
 */
import { withTransaction } from "@/lib/db";

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<LockResult<T>> {
  return withTransaction(async (q) => {
    const { rows } = await q<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [key],
    );
    if (!rows[0]?.acquired) return { acquired: false } as const;
    return { acquired: true, value: await fn() } as const;
  });
}

/** Cheia canonică pentru joburile de cron (aceeași ca în `runCron`). */
export function cronLockKey(job: string): string {
  return `cron:${job}`;
}

/**
 * Varianta pentru rute de cron fără audit în `cron_runs` (ex. dispatch-tick la
 * 10 s ar umple tabela): răspunsul handlerului dacă a obținut lock-ul, altfel
 * 200 `{ skipped: true }` — non-2xx ar fi tratat ca alertă de `cron-worker`.
 */
export async function withCronLock(job: string, fn: () => Promise<Response>): Promise<Response> {
  const res = await withAdvisoryLock(cronLockKey(job), fn);
  return res.acquired ? res.value : cronSkippedResponse(job);
}

/**
 * Răspuns standard pentru cazul în care jobul a fost sărit (o altă rulare îl
 * ține). 200, nu 4xx/5xx: nu e o eroare, iar declanșatorul de cron
 * (`infra/hetzner/cron-worker/run.sh`) tratează codurile non-2xx ca alerte.
 */
export function cronSkippedResponse(job: string): Response {
  return Response.json({ success: true, skipped: true, job, reason: "locked" });
}
