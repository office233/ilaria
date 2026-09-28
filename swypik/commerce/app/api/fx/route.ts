/**
 * GET /api/fx — cursurile valutare curente pentru afișarea prețurilor în client.
 * Sursa: tabela fx_rates (populată zilnic de cron/refresh-fx). Răspunsul e
 * exprimat ca 1 RON -> X TARGET (formatul FX_RATES din lib/i18n/fx.ts).
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";

// Cursurile se schimbă zilnic; cache scurt ca deploy-urile/refresh-ul manual
// să se reflecte rapid, dar fără să lovim DB la fiecare request.
export const revalidate = 300;

export async function GET() {
    try {
        // Tabela e populată de cron/refresh-fx cu baza EUR (formatul ECB).
        // Convertim la formatul de afișare al aplicației: 1 RON -> X TARGET.
        const { rows } = await dbQuery<{ base: string; quote: string; rate: string }>(
            `SELECT DISTINCT ON (base, quote) base, quote, rate::text
               FROM fx_rates
              ORDER BY base, quote, fetched_at DESC`
        );
        const eur: Record<string, number> = { EUR: 1 };
        for (const r of rows) {
            const rate = Number(r.rate);
            if (!Number.isFinite(rate) || rate <= 0) continue;
            if (r.base === "EUR") eur[r.quote] = rate;          // 1 EUR -> X quote
            else if (r.quote === "EUR") eur[r.base] = 1 / rate; // inversăm
        }
        const eurToRon = eur.RON;
        const rates: Record<string, number> = { RON: 1 };
        if (Number.isFinite(eurToRon) && eurToRon > 0) {
            for (const [ccy, eurToCcy] of Object.entries(eur)) {
                if (ccy === "RON") continue;
                // 1 RON = (1/eurToRon) EUR = (eurToCcy/eurToRon) CCY
                rates[ccy] = eurToCcy / eurToRon;
            }
        }
        return NextResponse.json({ base: "RON", rates });
    } catch {
        // Tabela poate lipsi în dev — clientul rămâne pe fallback-ul static.
        return NextResponse.json({ base: "RON", rates: { RON: 1 } });
    }
}
