import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const SYMBOLS = ["RON", "USD", "GBP", "PLN", "HUF", "CZK", "CHF", "SEK", "NOK", "DKK"];

async function authorize(req: Request) {
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

export async function GET(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await runCron("refresh-fx", async () => {
    // frankfurter: gratuit, fara access_key, format compatibil {rates:{...}}.
    // exchangerate.host a devenit paywalled (cere access_key) -> updated=0 silentios.
    // 2026-08-03: domeniul canonic e api.frankfurter.dev/v1 (.app face 301 cu
    // 522-uri intermitente pe Cloudflare -> FAIL-uri sporadice in cron).
    const fxApiBase = process.env.FX_API_URL || "https://api.frankfurter.dev/v1";
    const accessKey = process.env.FX_API_ACCESS_KEY;
    const url = `${fxApiBase}/latest?base=EUR&symbols=${SYMBOLS.join(",")}${accessKey ? `&access_key=${accessKey}` : ""}`;
    // 2026-08-11 (audit): frankfurter.dev da intermitent 520/522 (Cloudflare).
    // Facem retry + fallback pe un al doilea provider gratuit (open.er-api.com)
    // ca sa nu ramanem cu rate vechi din cauza unui hiccup de retea.
    let rates: Record<string, number> = {};
    let source = "frankfurter";
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2 && Object.keys(rates).length === 0; attempt++) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        lastStatus = res.status;
        if (res.ok) {
          const data = (await res.json()) as { rates?: Record<string, number> };
          rates = data?.rates || {};
        }
      } catch {
        /* retry / fallback */
      }
      if (Object.keys(rates).length === 0 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (Object.keys(rates).length === 0) {
      // Fallback: open.er-api.com (gratuit, fara cheie, alt CDN).
      try {
        const res = await fetch("https://open.er-api.com/v6/latest/EUR", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { rates?: Record<string, number> };
          if (data?.rates) {
            rates = data.rates;
            source = "er-api";
          }
        }
      } catch {
        /* raportam mai jos */
      }
    }
    if (Object.keys(rates).length === 0) {
      return NextResponse.json(
        { error: "upstream_failed", status: lastStatus || 502 },
        { status: 502 },
      );
    }
    let updated = 0;
    for (const quote of SYMBOLS) {
      const rate = rates[quote];
      if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) continue;
      try {
        await dbQuery(
          `INSERT INTO fx_rates (base, quote, rate, fetched_at)
         VALUES ('EUR', $1, $2, now())
         ON CONFLICT (base, quote) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = now()`,
          [quote, rate],
        );
        updated++;
      } catch (err) {
        logger.warn({ quote, err }, "[cron/refresh-fx] failed for");
      }
    }
    // Ensure EUR self-rate
    await dbQuery(
      `INSERT INTO fx_rates (base, quote, rate, fetched_at)
     VALUES ('EUR','EUR', 1.0, now())
     ON CONFLICT (base, quote) DO UPDATE SET rate = 1.0, fetched_at = now()`,
    );

    if (updated === 0) {
      // Nu masca esecul: upstream a raspuns 200 dar fara rate valide (ex. paywall).
      return NextResponse.json({ error: "no_rates_updated", upstream: fxApiBase }, { status: 502 });
    }

    return NextResponse.json({ updated, source, ts: new Date().toISOString() });
  });
  return res ?? cronSkippedResponse("refresh-fx");
}

export async function POST(req: Request) {
  return GET(req);
}
