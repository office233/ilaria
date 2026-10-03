/**
 * Cron: scanare zilnică prețuri competitori (piață) vs. prețurile noastre.
 *
 * Pentru fiecare destinație populară (plecare OTP, +30 zile):
 *   - prețul nostru real: Duffel + markup, în RON (același calcul ca în UI)
 *   - prețul pieței: Travelpayouts Data API (doar date, zero redirect)
 *   - salvăm ambele în fly_price_watch + logăm alertă unde suntem bătuți.
 *
 * Rulare: o dată pe zi (crontab VPS), header x-cron-secret.
 */
import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { timingSafeEqual } from "crypto";
import { duffelProvider } from "@/lib/fly/duffel";
import { getMarketMin, isMarketConfigured } from "@/lib/fly/market";
import { POPULAR_DESTINATIONS } from "@/lib/fly/destinations";
import { setRouteMarkup, clearRouteMarkup, minMarkupRonCents } from "@/lib/fly/repricing";
import { isFlyBookingEnabled } from "@/lib/fly/gate";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function authorize(req: NextRequest) {
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

const ORIGIN = "OTP";

async function GET_impl(req: NextRequest) {
    if (!(await authorize(req))) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Fără furnizor de zboruri (FEATURE_FLY_BOOKING OFF) nu avem ce urmări.
    if (!isFlyBookingEnabled()) {
        return NextResponse.json({ success: true, skipped: true, reason: "fly_booking_disabled" });
    }
    const result = await runCron("fly-price-watch", async () => {
            const departDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
            let scanned = 0;
            let beaten = 0;
            let repriced = 0;
            const alerts: string[] = [];

            for (const d of POPULAR_DESTINATIONS) {
                if (d.iata === ORIGIN) continue;
                try {
                    // Prețul nostru (cel mai ieftin, RON, markup inclus).
                    const offers = duffelProvider.isConfigured()
                        ? await duffelProvider.search({
                              origin: ORIGIN,
                              destination: d.iata,
                              departDate,
                              adults: 1,
                              cabin: "economy",
                              maxResults: 5,
                          })
                        : [];
                    const ourMin = offers.length
                        ? Math.min(...offers.map((o) => o.totalCents))
                        : null;

                    // Prețul pieței.
                    const market = await getMarketMin(ORIGIN, d.iata, departDate);

                    const delta =
                        ourMin !== null && market ? ourMin - market.minCents : null;

                    await dbQuery(
                        `INSERT INTO fly_price_watch
                            (origin, destination, depart_date, our_total_cents,
                             market_min_cents, market_source, market_airline, delta_cents)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                        [
                            ORIGIN,
                            d.iata,
                            departDate,
                            ourMin,
                            market?.minCents ?? null,
                            market?.source ?? null,
                            market?.airline ?? null,
                            delta,
                        ],
                    );
                    scanned++;

                    if (delta !== null && delta > 0) {
                        beaten++;
                        const msg = `${ORIGIN}→${d.iata}: noi ${(ourMin! / 100).toFixed(2)} RON vs piață ${(market!.minCents / 100).toFixed(2)} RON (+${(delta / 100).toFixed(2)})`;
                        alerts.push(msg);
                        logger.warn({ route: `${ORIGIN}-${d.iata}`, delta }, `fly price-watch: BĂTUȚI — ${msg}`);

                        // REPRICING AUTOMAT: scădem marja cât să fim cu 1 leu
                        // sub piață, dar niciodată sub marja minimă.
                        const standardMarkup = offers[0]?.markupCents ?? 0;
                        const neededMarkup = standardMarkup - delta - 100; // -1 leu sub piață
                        const newMarkup = Math.max(minMarkupRonCents(), neededMarkup);
                        if (newMarkup < standardMarkup) {
                            await setRouteMarkup(ORIGIN, d.iata, newMarkup, `beaten_by_market:${market!.source}`);
                            repriced++;
                            logger.info(
                                { route: `${ORIGIN}-${d.iata}`, newMarkup },
                                `fly price-watch: REPRICED — marjă ${(newMarkup / 100).toFixed(2)} RON`,
                            );
                        }
                    } else if (delta !== null && delta <= 0) {
                        // Suntem mai ieftini — dacă există override vechi, îl ștergem
                        // treptat (revenim la marja standard doar dacă avem >5 lei avans).
                        if (delta <= -500) await clearRouteMarkup(ORIGIN, d.iata);
                    }
                } catch (err) {
                    logger.warn({ err, dest: d.iata }, "fly price-watch: scan failed for route");
                }
            }

            return {
                scanned,
                beaten,
                repriced,
                market_configured: isMarketConfigured(),
                depart_date: departDate,
                alerts,
            };
    });
    if (result === null) return cronSkippedResponse("fly-price-watch");
    return NextResponse.json(result);
}

export const GET = withErrorHandling(GET_impl);
