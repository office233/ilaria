/**
 * Founding Drivers — comisioane pe trepte, promo 0% și retrogradare.
 *
 * TREPTE (atribuite secvențial, la aprobarea șoferului/curierului):
 *   founding15 — primii 500 aprobați. 15% comision PE VIAȚĂ, condiționat de
 *                activitate: minimum FOUNDING_MIN_RIDES curse la fiecare 90 de
 *                zile. Dacă ratează fereastra → retrogradare la early18.
 *   early18    — următorii 2000. 18%, fără condiție de activitate.
 *   standard20 — restul. 20% (comisionul standard al platformei).
 *
 * PROMO: primele PROMO_DAYS zile de la aprobare → 0% comision, indiferent de
 * treaptă (`promo_zero_until`). După expirare se aplică procentul treptei.
 *
 * Sursa de adevăr pentru procent este `effectiveCommissionPct()` — folosit de
 * lib/payments/mobility.ts la decontare. Zona (pricing_zones) rămâne fallback
 * pentru șoferii fără treaptă atribuită (date vechi).
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "drivers/tiers" });

export type CommissionTier = "founding15" | "early18" | "standard20";

/** Comisionul platformei (%) pentru fiecare treaptă. */
export const TIER_COMMISSION_PCT: Record<CommissionTier, number> = {
    founding15: 15,
    early18: 18,
    standard20: 20,
};

/** Zile de promo 0% comision de la aprobare (default; valoarea live vine din DB). */
export const PROMO_DAYS = 60;
/** Fereastra de activitate pentru păstrarea treptei founding15 (default). */
export const FOUNDING_ACTIVITY_WINDOW_DAYS = 90;
/** Curse minime în fereastră pentru păstrarea treptei founding15 (default). */
export const FOUNDING_MIN_RIDES = 50;

/**
 * 2026-08-11 (audit): parametrii operaționali sunt configurabili LIVE din
 * platform_config (chei: promo_days, founding_activity_window_days,
 * founding_min_rides) — schimbarea lor nu mai necesită redeploy.
 * Constantele de mai sus rămân fallback.
 */
export async function getTierParams(): Promise<{
    promoDays: number;
    activityWindowDays: number;
    minRides: number;
}> {
    const [promoDays, activityWindowDays, minRides] = await Promise.all([
        configInt("promo_days", PROMO_DAYS),
        configInt("founding_activity_window_days", FOUNDING_ACTIVITY_WINDOW_DAYS),
        configInt("founding_min_rides", FOUNDING_MIN_RIDES),
    ]);
    return { promoDays, activityWindowDays, minRides };
}

/** Numărul implicit de locuri, dacă platform_config lipsește. */
const DEFAULT_FOUNDING_SLOTS = 500;
const DEFAULT_EARLY_SLOTS = 2000;

export type TierSlots = {
    founding_total: number;
    founding_taken: number;
    founding_left: number;
    early_total: number;
    early_taken: number;
    early_left: number;
};

async function configInt(key: string, fallback: number): Promise<number> {
    try {
        const { rows } = await dbQuery<{ value: unknown }>(
            `SELECT value FROM platform_config WHERE key = $1`,
            [key],
        );
        const n = Number(rows[0]?.value);
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
    } catch {
        return fallback;
    }
}

/** Câte locuri mai sunt pe fiecare treaptă (pentru contorul public). */
export async function getTierSlots(): Promise<TierSlots> {
    const [foundingTotal, earlyTotal] = await Promise.all([
        configInt("founding_slots_total", DEFAULT_FOUNDING_SLOTS),
        configInt("early_slots_total", DEFAULT_EARLY_SLOTS),
    ]);
    const { rows } = await dbQuery<{ commission_tier: string; n: string }>(
        `SELECT commission_tier, count(*)::text AS n
       FROM couriers
      WHERE commission_tier IN ('founding15','early18')
      GROUP BY commission_tier`,
    );
    const taken = (t: string) => Number(rows.find((r) => r.commission_tier === t)?.n ?? 0);
    const foundingTaken = taken("founding15");
    const earlyTaken = taken("early18");
    return {
        founding_total: foundingTotal,
        founding_taken: foundingTaken,
        founding_left: Math.max(0, foundingTotal - foundingTaken),
        early_total: earlyTotal,
        early_taken: earlyTaken,
        early_left: Math.max(0, earlyTotal - earlyTaken),
    };
}

export type AssignResult = {
    tier: CommissionTier;
    /** true dacă șoferul avea deja o treaptă (no-op idempotent). */
    alreadyAssigned: boolean;
    promo_zero_until: string | null;
};

/**
 * Atribuie treapta la aprobarea unui șofer/curier. IDEMPOTENT: dacă are deja
 * `commission_tier`, nu schimbă nimic.
 *
 * Secvențialitatea (primii 500 / următorii 2000) e garantată de o tranzacție cu
 * `SELECT ... FOR UPDATE` pe rândul din platform_config, care serializează
 * aprobările concurente.
 */
export async function assignTierOnApproval(courierId: string): Promise<AssignResult> {
    const [foundingTotal, earlyTotal, tierParams] = await Promise.all([
        configInt("founding_slots_total", DEFAULT_FOUNDING_SLOTS),
        configInt("early_slots_total", DEFAULT_EARLY_SLOTS),
        getTierParams(),
    ]);

    return withTransaction(async (q) => {
        // lock global de alocare — serializează aprobările concurente
        await q(
            `INSERT INTO platform_config (key, value) VALUES ('tier_assign_lock', 'true'::jsonb)
       ON CONFLICT (key) DO NOTHING`,
        );
        await q(`SELECT 1 FROM platform_config WHERE key = 'tier_assign_lock' FOR UPDATE`);

        const { rows: cur } = await q<{
            commission_tier: string | null;
            promo_zero_until: string | null;
        }>(`SELECT commission_tier, promo_zero_until FROM couriers WHERE id = $1 FOR UPDATE`, [
            courierId,
        ]);
        if (!cur[0]) throw new Error(`courier_not_found: ${courierId}`);
        if (cur[0].commission_tier) {
            return {
                tier: cur[0].commission_tier as CommissionTier,
                alreadyAssigned: true,
                promo_zero_until: cur[0].promo_zero_until,
            };
        }

        const { rows: counts } = await q<{ commission_tier: string; n: string }>(
            `SELECT commission_tier, count(*)::text AS n
         FROM couriers
        WHERE commission_tier IN ('founding15','early18')
        GROUP BY commission_tier`,
        );
        const taken = (t: string) => Number(counts.find((r) => r.commission_tier === t)?.n ?? 0);

        let tier: CommissionTier;
        if (taken("founding15") < foundingTotal) tier = "founding15";
        else if (taken("early18") < earlyTotal) tier = "early18";
        else tier = "standard20";

        const activityDeadline =
            tier === "founding15" ? `now() + interval '${tierParams.activityWindowDays} days'` : "NULL";

        const { rows: upd } = await q<{ promo_zero_until: string }>(
            `UPDATE couriers
          SET commission_tier = $2,
              tier_assigned_at = now(),
              promo_zero_until = now() + interval '${tierParams.promoDays} days',
              tier_activity_deadline = ${activityDeadline},
              tier_rides_count = 0
        WHERE id = $1
        RETURNING promo_zero_until`,
            [courierId, tier],
        );

        log.info({ courier_id: courierId, tier }, "tier assigned on approval");
        return { tier, alreadyAssigned: false, promo_zero_until: upd[0]?.promo_zero_until ?? null };
    });
}

export type EffectiveCommission = {
    /** Procentul de comision al platformei aplicat acum. */
    platform_pct: number;
    /** Cota șoferului = 100 - platform_pct. */
    courier_pct: number;
    tier: CommissionTier | null;
    /** true dacă suntem în fereastra de promo 0%. */
    in_promo: boolean;
};

/**
 * Comisionul efectiv al unui șofer ACUM: 0% în promo, altfel procentul treptei.
 * Returnează null dacă șoferul nu are treaptă (apelantul folosește fallback-ul
 * pe zonă).
 */
export async function effectiveCommissionPct(
    courierId: string,
): Promise<EffectiveCommission | null> {
    const { rows } = await dbQuery<{
        commission_tier: CommissionTier | null;
        in_promo: boolean;
    }>(
        `SELECT commission_tier,
            (promo_zero_until IS NOT NULL AND promo_zero_until > now()) AS in_promo
       FROM couriers WHERE id = $1`,
        [courierId],
    );
    const row = rows[0];
    if (!row || !row.commission_tier) return null;
    const platform_pct = row.in_promo ? 0 : TIER_COMMISSION_PCT[row.commission_tier];
    return {
        platform_pct,
        courier_pct: 100 - platform_pct,
        tier: row.commission_tier,
        in_promo: row.in_promo,
    };
}

/**
 * Incrementează contorul de curse din fereastra curentă. Apelat la fiecare
 * cursă decontată. Când șoferul atinge pragul, fereastra se reînnoiește
 * imediat (a îndeplinit condiția) și contorul repornește.
 */
export async function recordTierRide(courierId: string): Promise<void> {
    const { activityWindowDays, minRides } = await getTierParams();
    await dbQuery(
        `UPDATE couriers
        SET tier_rides_count = tier_rides_count + 1
      WHERE id = $1`,
        [courierId],
    );
    await dbQuery(
        `UPDATE couriers
        SET tier_rides_count = 0,
            tier_activity_deadline = now() + interval '${activityWindowDays} days'
      WHERE id = $1
        AND commission_tier = 'founding15'
        AND tier_rides_count >= $2`,
        [courierId, minRides],
    );
}

/**
 * Retrogradează șoferii founding15 care au ratat fereastra de activitate.
 * Rulat zilnic din cron. Returnează numărul de retrogradări.
 */
export async function demoteInactiveFoundingDrivers(): Promise<number> {
    const { minRides } = await getTierParams();
    const { rows } = await dbQuery<{ id: string }>(
        `UPDATE couriers
        SET commission_tier = 'early18',
            tier_activity_deadline = NULL,
            tier_rides_count = 0
      WHERE commission_tier = 'founding15'
        AND tier_activity_deadline IS NOT NULL
        AND tier_activity_deadline < now()
        AND tier_rides_count < $1
      RETURNING id`,
        [minRides],
    );
    if (rows.length > 0) {
        log.info({ count: rows.length }, "founding drivers demoted for inactivity");
    }
    return rows.length;
}
