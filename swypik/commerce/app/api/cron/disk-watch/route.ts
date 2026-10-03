/**
 * /api/cron/disk-watch — alertă când spațiul liber pe gazdă scade sub prag.
 *
 * DE CE EXISTĂ (incident 2026-08-17):
 *   Cache-ul BuildKit a crescut la 64,81 GB (din care 0 activ) și a umplut
 *   partiția care găzduiește VHDX-ul WSL. VHDX-ul nu a mai putut crește →
 *   filesystem-ul distro-ului s-a remontat `emergency_ro` → binarele au început
 *   să dea `Input/output error` → daemonul Docker a murit → 502 pe swypik.com.
 *   Nu a existat niciun avertisment: discul s-a umplut în tăcere.
 *
 * DE CE PRIMEȘTE VALOAREA PRIN POST, ÎN LOC SĂ O MĂSOARE SINGUR:
 *   Verificat pe 2026-08-17 — containerele NU au niciun bind mount din gazdă:
 *     docker inspect swypik-prod-{cron-worker,web-next}-1 --format '{{.Mounts}}'
 *       → gol
 *     docker exec swypik-prod-cron-worker-1 df -h /
 *       → overlay 1006.9G, 937.5G liberi   (spațiul din VHDX)
 *     df -h pe gazdă, pe partiția cu VHDX-ul
 *       → 75G liberi                        (spațiul REAL)
 *   VHDX-ul crește dinamic, deci `df` dinăuntru raportează capacitatea virtuală
 *   a discului, nu spațiul rămas pe partiția fizică. În timpul incidentului,
 *   containerele „vedeau" 885 GB liberi în timp ce gazda avea 0,03 GB.
 *   Singurul loc cu vizibilitate reală e gazda WSL, prin crontab.
 *
 * CE PARTIȚIE SE MĂSOARĂ:
 *   Cea care găzduiește VHDX-ul. Din 19 august e `E:` (`/mnt/e`), nu `D:` —
 *   distro-ul a fost mutat. Ruta nu presupune nimic: primește `mount` în body
 *   și îl folosește doar în textul alertei, ca să se vadă la ce se referă
 *   cifra. Sursa adevărului e `scripts/ops/disk-watch.sh`, un singur loc de
 *   schimbat la o mutare viitoare.
 *
 * APELARE (din crontab-ul gazdei, orar) — vezi `scripts/ops/disk-watch.sh`:
 *   FREE_GB=$(df --output=avail -k /mnt/e | tail -1 | awk '{print int($1/1024/1024)}')
 *   curl -s -X POST -H "x-cron-secret: $CRON_SECRET" \
 *        -H 'content-type: application/json' \
 *        -d "{\"freeGb\":$FREE_GB,\"mount\":\"/mnt/e\"}" \
 *        http://localhost:3005/api/cron/disk-watch
 */
import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { notifyOps } from "@/lib/ops/alerts";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prag de alertare, în GB.
 *
 * 15 e deliberat peste cei 10 GB la care `scripts/deploy/wsl-deploy-web.sh` refuză să
 * pornească un build: vrem alerta ÎNAINTE ca deploy-ul să fie blocat, nu după.
 */
const DEFAULT_THRESHOLD_GB = 15;

function thresholdGb(): number {
  const raw = process.env.DISK_WATCH_MIN_FREE_GB;
  if (!raw) return DEFAULT_THRESHOLD_GB;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_GB;
}

async function authorize(req: NextRequest): Promise<boolean> {
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

async function POST_impl(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const freeGb = Number(b.freeGb);
  if (!Number.isFinite(freeGb) || freeGb < 0) {
    return NextResponse.json(
      { error: "freeGb lipsă sau invalid (număr de GB liberi pe gazdă)" },
      { status: 400 },
    );
  }
  const mount = typeof b.mount === "string" ? b.mount.slice(0, 64) : "necunoscut";
  const min = thresholdGb();

  const result = await runCron("disk-watch", async () => {
    if (freeGb >= min) {
      return { freeGb, thresholdGb: min, mount, alerted: false };
    }

    // Sub prag: cu cât e mai puțin spațiu, cu atât alerta e mai gravă și mai
    // frecventă. Sub 5 GB suntem la câteva build-uri de repetarea incidentului.
    const critical = freeGb < 5;
    // `notifyOps` întoarce `false` când cooldown-ul a suprimat trimiterea.
    // Ignorând valoarea, ruta raporta `alerted: true` și când nu plecase
    // nimic — deci un test manual „văd alerted:true, deci merge" putea trece
    // fără ca vreo alertă să existe. Diferențiem cele două stări.
    const sent = await notifyOps({
      key: `disk_low:${mount}`,
      severity: critical ? "critical" : "warning",
      title: `Spațiu redus pe gazdă: ${freeGb} GB liberi (${mount})`,
      detail: [
        `Prag de alertare: ${min} GB. Liber acum: ${freeGb} GB.`,
        "",
        "Sub 10 GB, scripts/deploy/wsl-deploy-web.sh refuză să pornească un build.",
        "Dacă discul se umple complet, VHDX-ul WSL nu mai poate crește și",
        "filesystem-ul distro-ului intră în emergency_ro — Docker moare și",
        "site-ul cade cu 502 (s-a întâmplat pe 2026-08-17).",
        "",
        "Eliberare rapidă, în ordinea impactului:",
        "  docker builder prune -af     # cache-ul de build, principalul vinovat",
        "  docker image prune -f        # imagini fără tag",
        "  docker system df             # ce ocupă efectiv spațiul",
      ].join("\n"),
      payload: { freeGb, thresholdGb: min, mount, critical },
      cooldownMin: critical ? 30 : 180,
    });

    return {
      freeGb, thresholdGb: min, mount, critical,
      alerted: sent,
      // `true` = sub prag, dar alerta a fost înghițită de cooldown.
      suppressedByCooldown: !sent,
    };
  });

  if (result === null) return cronSkippedResponse("disk-watch");
  return NextResponse.json({ ok: true, ...result });
}

export const POST = withErrorHandling(POST_impl);
