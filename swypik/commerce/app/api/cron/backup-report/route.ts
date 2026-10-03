/**
 * /api/cron/backup-report — heartbeat + alertare pentru backup-ul PostgreSQL.
 *
 * DE CE EXISTĂ (incident 2026-08-02 … 2026-08-17):
 *   `infra/hetzner/backup-postgres.sh` era `100644` în git. Cron îl invocă
 *   direct, nu prin `bash`, deci după `git pull`-ul din 4 august a început să
 *   dea `Permission denied`. Rezultatul: 15 zile fără niciun backup, cu
 *   producția pornind în tot acest timp o migrație, un incident de disc și un
 *   restart brutal al Postgres. Nimeni nu a aflat, pentru că eșecul se scria
 *   doar într-un fișier de log pe care nu-l citea nimeni.
 *
 *   Permisiunea a fost reparată; DAR cauza reală a duratei de 15 zile nu e
 *   permisiunea, ci absența unui semnal. Ruta asta îl produce.
 *
 * DOUĂ MECANISME, DELIBERAT DIFERITE:
 *   POST — scriptul raportează după fiecare rulare (`success` sau `failed`).
 *          Acoperă eșecurile scriptului CARE PORNEȘTE.
 *   GET  — verifică cât timp a trecut de la ultimul raport reușit și alertează
 *          peste `BACKUP_MAX_AGE_HOURS`. Acoperă exact cazul din incident:
 *          scriptul NU pornește deloc, deci nu poate raporta nimic. Un
 *          heartbeat lipsă e singurul semnal disponibil când sursa e mută.
 *          Se apelează din `cron-worker`, alături de celelalte joburi.
 */
import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { notifyOps } from "@/lib/ops/alerts";
import { dbQuery } from "@/lib/db";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backup-ul rulează zilnic la 03:15. 48h = două rulări ratate, nu una. */
const DEFAULT_MAX_AGE_HOURS = 48;

/** Sub asta dump-ul e aproape sigur trunchiat (referință: 166 KB pe 2026-08-02). */
const MIN_PLAUSIBLE_BYTES = 50_000;

function maxAgeHours(): number {
  const raw = process.env.BACKUP_MAX_AGE_HOURS;
  if (!raw) return DEFAULT_MAX_AGE_HOURS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AGE_HOURS;
}

function authorize(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/** Raport de la scriptul de backup, după fiecare rulare. */
async function POST_impl(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const status = b.status === "success" ? "success" : "failed";
  const sizeBytes = Number.isFinite(Number(b.sizeBytes)) ? Number(b.sizeBytes) : 0;
  const detail = typeof b.detail === "string" ? b.detail.slice(0, 2000) : "";

  // Un „succes" cu dump ridicol de mic e tot un eșec — scriptul are propriile
  // praguri, dar dacă cineva le coboară din env (ca în crontab-ul actual,
  // MIN_SIZE=100000) vrem să vedem asta oricum.
  const suspect = status === "success" && sizeBytes > 0 && sizeBytes < MIN_PLAUSIBLE_BYTES;

  await dbQuery(
    "INSERT INTO cron_runs(job_name, status, result, completed_at) VALUES($1,$2,$3,NOW())",
    [
      "backup-postgres",
      status === "success" && !suspect ? "success" : "failed",
      JSON.stringify({ sizeBytes, detail, suspect }),
    ],
  );

  if (status !== "success" || suspect) {
    await notifyOps({
      key: "backup_failed",
      severity: "critical",
      title: suspect
        ? `Backup PostgreSQL suspect: doar ${sizeBytes} bytes`
        : "Backup PostgreSQL EȘUAT",
      detail: [
        detail || "(fără detalii de la script)",
        "",
        "Backup-ul zilnic al bazei de producție nu s-a finalizat corect.",
        "Verificare:",
        "  tail -30 /opt/swypik/logs/backup-cron.log",
        "  ls -la /opt/swypik/backups/",
        "",
        "Cauză deja întâlnită (2026-08-02): bitul de execuție pierdut la git pull.",
        "  ls -la /opt/swypik/app/infra/hetzner/backup-postgres.sh   # trebuie -rwxr-xr-x",
      ].join("\n"),
      payload: { status, sizeBytes, suspect },
      cooldownMin: 60,
    });
  }

  return NextResponse.json({ ok: true, status, sizeBytes, suspect });
}

/** Detector de tăcere: alertează dacă nu a mai venit niciun backup reușit. */
async function GET_impl(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await runCron("backup-watchdog", async () => {
    const maxAge = maxAgeHours();
    const { rows } = await dbQuery<{ completed_at: Date | null; age_hours: number | null }>(
      `SELECT completed_at,
              EXTRACT(EPOCH FROM (NOW() - completed_at)) / 3600 AS age_hours
         FROM cron_runs
        WHERE job_name = 'backup-postgres' AND status = 'success'
        ORDER BY completed_at DESC
        LIMIT 1`,
    );

    const last = rows[0] ?? null;
    const ageHours = last?.age_hours != null ? Math.round(Number(last.age_hours)) : null;
    // `null` = niciun backup reușit raportat vreodată. Tratat ca depășire:
    // e exact starea în care se afla sistemul pe 17 august.
    const stale = ageHours === null || ageHours > maxAge;

    if (!stale) {
      return { lastBackupAt: last?.completed_at ?? null, ageHours, maxAgeHours: maxAge, alerted: false };
    }

    const sent = await notifyOps({
      key: "backup_stale",
      severity: "critical",
      title:
        ageHours === null
          ? "Niciun backup PostgreSQL raportat vreodată"
          : `Ultimul backup PostgreSQL reușit acum ${ageHours}h (prag ${maxAge}h)`,
      detail: [
        "Cron-ul de backup nu mai raportează. Cel mai probabil nici nu pornește.",
        "",
        "Verificare, în ordine:",
        "  crontab -l | grep backup",
        "  ls -la /opt/swypik/app/infra/hetzner/backup-postgres.sh   # trebuie -rwxr-xr-x",
        "  tail -30 /opt/swypik/logs/backup-cron.log",
        "",
        "Rulare manuală:",
        "  /opt/swypik/app/infra/hetzner/backup-postgres.sh",
      ].join("\n"),
      payload: { ageHours, maxAgeHours: maxAge },
      cooldownMin: 360,
    });

    return {
      lastBackupAt: last?.completed_at ?? null,
      ageHours,
      maxAgeHours: maxAge,
      // `notifyOps` întoarce `false` dacă cooldown-ul (6h) a suprimat
      // trimiterea. Raportarea unui `alerted: true` neadevărat ar face ca o
      // verificare manuală să confirme o alertă care n-a plecat.
      alerted: sent,
      suppressedByCooldown: !sent,
    };
  });

  if (result === null) return cronSkippedResponse("backup-watchdog");
  return NextResponse.json({ ok: true, ...result });
}

export const POST = withErrorHandling(POST_impl);
export const GET = withErrorHandling(GET_impl);
