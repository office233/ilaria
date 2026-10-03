/**
 * /api/cron/checkout-health — alertă când plățile sunt rupte.
 *
 * DE CE EXISTĂ (descoperit la auditul din 2026-08-17):
 *   Producția a rulat cu `sk_placeholder` / `pk_placeholder` / `whsec_placeholder`.
 *   Rezultat: 13 comenzi `failed` între 2 și 4 august, ZERO `paid` vreodată,
 *   `processed_stripe_events` gol. Nimeni n-a observat 15 zile.
 *
 *   Instrumentarea NU lipsea. `logCheckoutEvent` scrisese deja cauza exactă în
 *   `checkout_audit_log`, de 12 ori, în clar:
 *       checkout_fail | Invalid API Key provided: sk_place**lder
 *   Lipsea cineva care să citească. Jobul ăsta e acel cineva — nu inventează un
 *   semnal nou, doar ridică la suprafață unul care exista deja.
 *
 * DE CE ALERTEAZĂ PE RAPORT, NU PE ABSOLUT:
 *   „0 plăți reușite în 24h" ar fi zgomotos pe un magazin cu trafic mic: zero
 *   comenzi e starea normală în multe zile. Semnalul real e „se încearcă și
 *   eșuează tot", adică un raport de eșec ridicat peste un volum minim.
 *   Când nu există nicio încercare, tăcem — absența traficului nu e o defecțiune.
 *
 * PRAGURI — DELIBERAT CONSERVATOARE, DE RECALIBRAT:
 *   Alese pe un istoric fără nicio plată reușită, deci fără rată de eșec
 *   normală de referință. După primele săptămâni de trafic real, verifică
 *   rata observată și strânge pragurile:
 *       SELECT date_trunc('day', created_at) AS zi,
 *              count(*) FILTER (WHERE status='failed') AS esec,
 *              count(*) FILTER (WHERE status IN ('paid','fulfilled','delivered')) AS ok
 *         FROM commerce_orders GROUP BY 1 ORDER BY 1 DESC LIMIT 30;
 *   Un magazin sănătos are eșecuri (carduri respinse, 3DS abandonat) — pragul
 *   trebuie să stea peste zgomotul de fond, altfel alerta devine ignorată.
 *
 * APELARE (orar, ca celelalte joburi):
 *   curl -s -H "x-cron-secret: $CRON_SECRET" \
 *        http://localhost:3005/api/cron/checkout-health
 */
import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { notifyOps } from "@/lib/ops/alerts";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Statusuri care dovedesc că banii au intrat.
 *
 * `paid` nu e suficient: o comandă plătită avansează la `fulfilled` și apoi
 * `delivered`, iar una rambursată (`refunded`) a fost plătită înainte. Dacă am
 * număra doar `paid`, un magazin care își procesează comenzile rapid ar părea
 * că nu încasează nimic. Statusurile din CHECK-ul tabelei (verificat în prod):
 *   pending, authorized, paid, fulfilled, delivered, return_requested,
 *   cancelled, refunded, failed
 */
const SUCCESS_STATUSES = [
  "paid",
  "fulfilled",
  "delivered",
  "return_requested",
  "refunded",
] as const;

/** Nu alertăm sub acest volum: 1-2 eșecuri izolate sunt zgomot normal. */
const MIN_ATTEMPTS = 5;

/** Peste acest raport de eșec, cu volumul minim atins, alertăm. */
const FAIL_RATIO_THRESHOLD = 0.5;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

type Counts = { failed: number; succeeded: number };

async function POST_or_GET(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const minAttempts = intFromEnv("CHECKOUT_HEALTH_MIN_ATTEMPTS", MIN_ATTEMPTS);
  const ratioThreshold = (() => {
    const raw = process.env.CHECKOUT_HEALTH_FAIL_RATIO;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : FAIL_RATIO_THRESHOLD;
  })();

  const result = await runCron("checkout-health", async () => {
    const { rows } = await dbQuery<Counts>(
      `SELECT
         count(*) FILTER (WHERE status = 'failed')::int      AS failed,
         count(*) FILTER (WHERE status = ANY($1::text[]))::int AS succeeded
       FROM commerce_orders
       WHERE created_at > now() - interval '24 hours'`,
      [SUCCESS_STATUSES as unknown as string[]],
    );

    const failed = rows[0]?.failed ?? 0;
    const succeeded = rows[0]?.succeeded ?? 0;
    const attempts = failed + succeeded;

    // Nicio încercare = magazin liniștit, nu magazin stricat.
    if (attempts < minAttempts) {
      return { failed, succeeded, attempts, alerted: false, reason: "volum sub prag" };
    }

    const ratio = failed / attempts;
    if (ratio <= ratioThreshold) {
      return { failed, succeeded, attempts, ratio, alerted: false };
    }

    // Zero încasări din N încercări = configurare ruptă, nu carduri respinse.
    const total = succeeded === 0;

    // Cauza exactă e deja în checkout_audit_log — o includem în alertă, ca
    // destinatarul să primească diagnosticul, nu doar simptomul. Exact mesajul
    // ăsta („Invalid API Key provided: sk_place**lder") ar fi scurtat cu 15
    // zile investigația din august.
    let lastError: string | null = null;
    try {
      const err = await dbQuery<{ error: string }>(
        `SELECT error FROM checkout_audit_log
          WHERE event IN ('checkout_fail', 'webhook_fail')
            AND error IS NOT NULL
            AND created_at > now() - interval '24 hours'
          ORDER BY created_at DESC LIMIT 1`,
      );
      lastError = err.rows[0]?.error ?? null;
    } catch {
      // Diagnosticul e un bonus; lipsa lui nu blochează alerta.
    }

    // Vezi disk-watch: valoarea returnată distinge „alertă trimisă" de
    // „alertă suprimată de cooldown". Fără ea, `alerted: true` e o afirmație
    // pe care nimeni n-a verificat-o.
    const sent = await notifyOps({
      key: "checkout_health",
      severity: total ? "critical" : "warning",
      title: total
        ? `Plățile par rupte: ${failed} comenzi eșuate, 0 reușite în 24h`
        : `Rată mare de eșec la checkout: ${failed}/${attempts} în 24h`,
      detail: [
        `Eșuate: ${failed}   Reușite: ${succeeded}   Total încercări: ${attempts}`,
        `Rată de eșec: ${(ratio * 100).toFixed(0)}% (prag ${(ratioThreshold * 100).toFixed(0)}%)`,
        "",
        lastError
          ? `Ultima eroare din checkout_audit_log:\n  ${lastError}`
          : "Nicio eroare în checkout_audit_log — verifică logurile aplicației.",
        "",
        "De verificat, în ordine:",
        "  1. cheile Stripe din containerul care rulează:",
        "     docker exec swypik-prod-web-next-1 sh -c 'echo $STRIPE_SECRET_KEY' | cut -c1-12",
        "     (dacă apare `sk_placeholder`, plățile sunt oprite din configurare)",
        "  2. SELECT event, error, count(*) FROM checkout_audit_log",
        "      WHERE created_at > now() - interval '24 hours' GROUP BY 1,2;",
        "  3. SELECT count(*) FROM processed_stripe_events",
        "      WHERE processed_at > now() - interval '24 hours';",
        "     (0 = webhook-urile nu ajung sau semnătura nu se potrivește)",
      ].join("\n"),
      payload: { failed, succeeded, attempts, ratio, lastError },
      cooldownMin: total ? 120 : 360,
    });

    return {
      failed, succeeded, attempts, ratio, critical: total, lastError,
      alerted: sent,
      suppressedByCooldown: !sent,
    };
  });

  if (result === null) return cronSkippedResponse("checkout-health");
  return NextResponse.json({ ok: true, ...result });
}

export const GET = withErrorHandling(POST_or_GET);
export const POST = withErrorHandling(POST_or_GET);
