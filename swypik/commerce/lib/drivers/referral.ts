/**
 * Referral șofer→client (Founding Drivers).
 *
 *  - Fiecare șofer/curier aprobat are un cod scurt (driver_referral_codes),
 *    format SWK + 5 caractere alfanumerice, generat lazy.
 *  - Un client nou poate introduce codul la înregistrare (sau vine prin
 *    /r/[code], care acum acceptă și coduri de șofer). Legătura se salvează în
 *    driver_referred_users, valabilă 6 luni (expires_at).
 *  - Beneficii cât legătura e activă:
 *      · clientul: 2% reducere la fiecare cursă, plafonat la 15 RON/cursă
 *        (driverReferralDiscountCents — aplicat pe final_fare la decontare);
 *      · șoferul: bonus unic de 5 RON (500 cenți) în wallet la PRIMA cursă
 *        finalizată a clientului (idempotent prin wallet ledger:
 *        ref_type='driver_referral_bonus', ref_id=user-ul invitat).
 *
 * Eligibilitate cod la signup/claim: codul există, șoferul e aprobat, userul
 * are cont mai nou de 7 zile SAU zero curse, nu are deja un referral de șofer.
 */
import { randomBytes } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { creditUser } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "drivers/referral" });

/** Reducerea clientului: 50% pe primele 3 curse (decizie owner, achiziție). */
export const REFERRAL_DISCOUNT_PCT = 50;
/** Numărul de curse cu reducere. */
export const REFERRAL_DISCOUNTED_RIDES = 3;
/** Plafon reducere per cursă: 15 RON. */
export const REFERRAL_DISCOUNT_CAP_CENTS = 1500;
/** Bonus șofer la prima cursă a clientului: 5 RON. */
export const REFERRAL_FIRST_RIDE_BONUS_CENTS = 500;
/** Valabilitatea legăturii de referral: 6 luni. */
export const REFERRAL_VALIDITY_MONTHS = 6;

const CODE_RE = /^SWK[A-Z0-9]{5}$/;

/** Formatul codurilor de șofer (diferit de codurile user-user din /r). */
export function isDriverReferralCode(code: string): boolean {
    return CODE_RE.test(code.toUpperCase());
}

/** Codul șoferului — creat lazy la prima cerere. */
export async function getOrCreateDriverCode(courierId: string): Promise<string> {
    const { rows } = await dbQuery<{ code: string }>(
        `SELECT code FROM driver_referral_codes WHERE courier_id = $1`,
        [courierId],
    );
    if (rows[0]) return rows[0].code;

    // alfabet fără caractere ambigue (0/O, 1/I/L)
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 8; attempt++) {
        const buf = randomBytes(5);
        let code = "SWK";
        for (let i = 0; i < 5; i++) code += alphabet[buf[i] % alphabet.length];
        const { rows: ins } = await dbQuery<{ code: string }>(
            `INSERT INTO driver_referral_codes (courier_id, code) VALUES ($1, $2)
       ON CONFLICT (courier_id) DO NOTHING
       RETURNING code`,
            [courierId, code],
        );
        if (ins[0]) return ins[0].code;
        // conflict pe courier_id (creat concurent) sau pe code (coliziune)
        const { rows: existing } = await dbQuery<{ code: string }>(
            `SELECT code FROM driver_referral_codes WHERE courier_id = $1`,
            [courierId],
        );
        if (existing[0]) return existing[0].code;
    }
    throw new Error("driver_referral_code_generation_failed");
}

export type ClaimResult =
    | { ok: true }
    | {
        ok: false;
        reason:
        | "invalid_code"
        | "driver_not_approved"
        | "already_referred"
        | "not_new_user";
    };

/**
 * Leagă un user de codul unui șofer. Idempotent-safe: refuză dacă userul are
 * deja o legătură. Apelat la signup (cod din formular sau cookie /r/[code]).
 */
export async function claimDriverReferral(userId: string, rawCode: string): Promise<ClaimResult> {
    const code = (rawCode || "").trim().toUpperCase();
    if (!isDriverReferralCode(code)) return { ok: false, reason: "invalid_code" };

    const { rows: codeRows } = await dbQuery<{
        courier_id: string;
        verification_status: string;
        courier_user_id: string | null;
    }>(
        `SELECT drc.courier_id, c.verification_status, c.user_id AS courier_user_id
       FROM driver_referral_codes drc
       JOIN couriers c ON c.id = drc.courier_id
      WHERE drc.code = $1`,
        [code],
    );
    const found = codeRows[0];
    if (!found) return { ok: false, reason: "invalid_code" };
    if (found.verification_status !== "approved") {
        return { ok: false, reason: "driver_not_approved" };
    }
    // auto-referral interzis
    if (found.courier_user_id && found.courier_user_id === userId) {
        return { ok: false, reason: "not_new_user" };
    }

    const { rows: existing } = await dbQuery(
        `SELECT 1 FROM driver_referred_users WHERE user_id = $1`,
        [userId],
    );
    if (existing.length > 0) return { ok: false, reason: "already_referred" };

    // user "nou": cont < 7 zile SAU zero curse finalizate
    const { rows: userRows } = await dbQuery<{ is_new: boolean }>(
        `SELECT (u.created_at > now() - interval '7 days'
             OR NOT EXISTS (SELECT 1 FROM rides r WHERE r.rider_user_id = u.id AND r.status = 'completed'))
            AS is_new
       FROM users u WHERE u.id = $1`,
        [userId],
    );
    if (!userRows[0]?.is_new) return { ok: false, reason: "not_new_user" };

    await dbQuery(
        `INSERT INTO driver_referred_users (user_id, courier_id, code, expires_at)
     VALUES ($1, $2, $3, now() + interval '${REFERRAL_VALIDITY_MONTHS} months')
     ON CONFLICT (user_id) DO NOTHING`,
        [userId, found.courier_id, code],
    );
    log.info({ user_id: userId, courier_id: found.courier_id, code }, "driver referral claimed");
    return { ok: true };
}

/**
 * Reducerea de referral pentru o cursă a clientului: 50% din tarif (max 15 RON)
 * pe PRIMELE 3 curse finalizate, cât timp legătura există și nu a expirat.
 * De la a 4-a cursă: 0 (șoferul-recrutor își păstrează earn-ul separat).
 * Reducerea o suportă platforma — splitul șoferului se face pe tariful întreg.
 */
export async function driverReferralDiscountCents(
    riderId: string,
    fareCents: number,
): Promise<number> {
    if (fareCents <= 0) return 0;
    const { rows } = await dbQuery(
        `SELECT 1 FROM driver_referred_users WHERE user_id = $1 AND expires_at > now()`,
        [riderId],
    );
    if (rows.length === 0) return 0;
    const { rows: cnt } = await dbQuery<{ n: string }>(
        `SELECT count(*)::text AS n FROM rides WHERE rider_user_id = $1 AND status = 'completed'`,
        [riderId],
    );
    if (Number(cnt[0]?.n ?? 0) >= REFERRAL_DISCOUNTED_RIDES) return 0;
    return Math.min(
        Math.round((fareCents * REFERRAL_DISCOUNT_PCT) / 100),
        REFERRAL_DISCOUNT_CAP_CENTS,
    );
}

/**
 * Bonus 5 RON pentru șofer la PRIMA cursă finalizată a clientului invitat.
 * Idempotent: ledger-ul refuză dubluri pe (ref_type, ref_id, kind), iar
 * first_ride_bonus_paid previne re-procesarea.
 */
export async function payFirstRideBonusIfDue(riderId: string): Promise<boolean> {
    const { rows } = await dbQuery<{ courier_id: string; courier_user_id: string | null }>(
        `SELECT dru.courier_id, c.user_id AS courier_user_id
       FROM driver_referred_users dru
       JOIN couriers c ON c.id = dru.courier_id
      WHERE dru.user_id = $1
        AND dru.expires_at > now()
        AND dru.first_ride_bonus_paid = false`,
        [riderId],
    );
    const row = rows[0];
    if (!row || !row.courier_user_id) return false;

    await creditUser({
        userId: row.courier_user_id,
        amountCents: REFERRAL_FIRST_RIDE_BONUS_CENTS,
        refType: "driver_referral_bonus",
        refId: riderId,
        description: "Bonus referral: prima cursă a clientului invitat",
    });
    await dbQuery(
        `UPDATE driver_referred_users SET first_ride_bonus_paid = true WHERE user_id = $1`,
        [riderId],
    );
    log.info({ rider_id: riderId, courier_id: row.courier_id }, "driver referral first-ride bonus paid");
    return true;
}

export type DriverReferralStats = {
    code: string | null;
    active_clients: number;
    total_bonus_cents: number;
};

/** Statistici pentru secțiunea „Clienții mei" din PWA curier. */
export async function getDriverReferralStats(courierId: string): Promise<DriverReferralStats> {
    const [{ rows: codeRows }, { rows: cliRows }] = await Promise.all([
        dbQuery<{ code: string }>(`SELECT code FROM driver_referral_codes WHERE courier_id = $1`, [
            courierId,
        ]),
        dbQuery<{ active_clients: string }>(
            `SELECT count(*)::text AS active_clients
         FROM driver_referred_users
        WHERE courier_id = $1 AND expires_at > now()`,
            [courierId],
        ),
    ]);
    const { rows: bonusRows } = await dbQuery<{ total: string }>(
        `SELECT COALESCE(sum(l.amount_cents), 0)::text AS total
       FROM wallet_ledger_entries l
       JOIN couriers c ON c.user_id = l.user_id
      WHERE c.id = $1 AND l.ref_type = 'driver_referral_bonus' AND l.kind = 'credit'`,
        [courierId],
    );
    return {
        code: codeRows[0]?.code ?? null,
        active_clients: Number(cliRows[0]?.active_clients ?? 0),
        total_bonus_cents: Number(bonusRows[0]?.total ?? 0),
    };
}
