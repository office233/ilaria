/**
 * Market intelligence pentru Swypik Fly.
 *
 * IMPORTANT — regulă de business inviolabilă:
 *   Folosim Travelpayouts Data API EXCLUSIV ca sursă de INFORMAȚII despre
 *   prețurile pieței (cache de tarife văzute de alți utilizatori). NU generăm
 *   niciun link de afiliere, NU redirecționăm niciun client. Tot ce vinde
 *   Swypik trece prin Duffel, cu noi ca merchant of record și prețul stabilit
 *   de noi. Datele de aici servesc DOAR la:
 *     1. a ști dacă suntem cei mai ieftini,
 *     2. a regla marja automat (repricing),
 *     3. a afișa onest "cel mai mic preț" în UI.
 *
 * Env: TRAVELPAYOUTS_TOKEN (opțional — fără el sistemul rulează degradat,
 * raportând doar prețurile noastre).
 */
import { logger } from "@/lib/logger";
import { toRonCents } from "./fx";

const API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

export type MarketQuote = {
    minCents: number; // în bani RON
    airline: string | null;
    source: "travelpayouts";
};

export function isMarketConfigured(): boolean {
    return Boolean(process.env.TRAVELPAYOUTS_TOKEN);
}

/**
 * Cel mai mic preț văzut în piață pentru ruta+data dată.
 * Returnează null dacă nu avem token sau nu există date.
 */
export async function getMarketMin(
    origin: string,
    destination: string,
    departDate: string,
): Promise<MarketQuote | null> {
    const token = process.env.TRAVELPAYOUTS_TOKEN;
    if (!token) return null;

    const fetchRows = async (departureAt: string): Promise<any[]> => {
        const url =
            `${API}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}` +
            `&departure_at=${encodeURIComponent(departureAt)}&currency=ron&limit=30&sorting=price&one_way=true&token=${encodeURIComponent(token)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) {
            logger.warn({ status: r.status, origin, destination }, "fly market: HTTP error");
            return [];
        }
        const j = (await r.json()) as { success?: boolean; data?: any[] };
        return j.data ?? [];
    };

    try {
        // Întâi ziua exactă; cache-ul lor nu are mereu fiecare zi, deci
        // fallback pe luna întreagă (minimul lunii = comparație mai dură cu
        // noi, deci nu riscăm să ne credem ieftini pe nedrept).
        let rows = await fetchRows(departDate);
        if (!rows.length) rows = await fetchRows(departDate.slice(0, 7));
        if (!rows.length) return null;

        let best: { price: number; airline: string | null } | null = null;
        for (const row of rows) {
            const p = Number(row.price);
            if (!Number.isFinite(p) || p <= 0) continue;
            if (!best || p < best.price) best = { price: p, airline: row.airline ?? null };
        }
        if (!best) return null;

        // API-ul răspunde deja în RON (currency=ron); valorile sunt unități, nu bani.
        return { minCents: Math.round(best.price * 100), airline: best.airline, source: "travelpayouts" };
    } catch (err) {
        logger.warn({ err, origin, destination }, "fly market: fetch failed");
        return null;
    }
}

/**
 * Convertor helper pentru cazul în care cerem altă monedă decât RON.
 * Păstrat pentru flexibilitate viitoare.
 */
export async function marketToRon(amountCents: number, currency: string): Promise<number> {
    return toRonCents(amountCents, currency);
}
