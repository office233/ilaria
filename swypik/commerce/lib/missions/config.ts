/**
 * Limitele misiunilor — configurabile prin env, cu default-uri documentate
 * într-un singur loc. Toate sumele sunt în cenți RON (bani).
 */

function intFromEnv(name: string, fallback: number, min = 0): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.trunc(raw) : fallback;
}

export const MISSION_CURRENCY = "RON" as const;

export function missionLimits() {
  return {
    /** Premiul minim per câștigător (default 50 RON). */
    minPrizeCents: intFromEnv("MISSION_MIN_PRIZE_CENTS", 5_000, 100),
    /** Premiul maxim per câștigător (default 10.000 RON). */
    maxPrizeCents: intFromEnv("MISSION_MAX_PRIZE_CENTS", 1_000_000, 100),
    /** Numărul maxim de câștigători per misiune (default 20). */
    maxWinners: intFromEnv("MISSION_MAX_WINNERS", 20, 1),
    /** Durata maximă a unei misiuni în zile (default 60). */
    maxDurationDays: intFromEnv("MISSION_MAX_DURATION_DAYS", 60, 1),
    /** Durata minimă în zile (default 3). */
    minDurationDays: intFromEnv("MISSION_MIN_DURATION_DAYS", 3, 1),
  };
}

/** Fondul total de premii care trebuie finanțat: premiu × câștigători. */
export function missionPoolCents(prizeCents: number, maxWinners: number): number {
  if (!Number.isInteger(prizeCents) || prizeCents <= 0) return 0;
  if (!Number.isInteger(maxWinners) || maxWinners <= 0) return 0;
  return prizeCents * maxWinners;
}

export type EscrowState = {
  funded_cents: number | string;
  paid_out_cents: number | string;
  refunded_cents: number | string;
};

/** Suma încă disponibilă în escrow (finanțat − plătit − returnat). */
export function escrowRemainingCents(m: EscrowState): number {
  const rest = Number(m.funded_cents) - Number(m.paid_out_cents) - Number(m.refunded_cents);
  return rest > 0 ? rest : 0;
}

/**
 * Premiile de misiune (ledger `mission_prize`) sunt reținute atâtea zile
 * înainte să poată fi retrase (default 14): acoperă disputele pe plata de
 * finanțare a sellerului și revizuirea anti-fraudă (câștigător „marionetă”).
 */
export function missionPrizeHoldDays(): number {
  return intFromEnv("MISSION_PRIZE_HOLD_DAYS", 14, 0);
}

/** Fereastra (zile) în care sesiunile cu același IP/dispozitiv leagă câștigătorul de seller. */
export function missionSelfDealingWindowDays(): number {
  return intFromEnv("MISSION_SELF_DEALING_WINDOW_DAYS", 30, 1);
}

/** Cronul missions-expire: zile de grație după ends_at (jurizare) + plafon per rulare. */
export function missionExpireConfig(): { graceDays: number; limit: number } {
  return {
    graceDays: intFromEnv("MISSION_EXPIRE_GRACE_DAYS", 7, 0),
    limit: intFromEnv("MISSION_EXPIRE_BATCH", 50, 1),
  };
}

/** Mașina de stări: o misiune se poate închide doar din draft/active. */
const CLOSABLE_STATUSES = new Set(["draft", "active"]);

export function canCloseMission(status: string): boolean {
  return CLOSABLE_STATUSES.has(status);
}

/** Premiile se pot plăti doar cât misiunea e activă (nu după închidere/arhivare). */
export function canPayMissionPrize(status: string): boolean {
  return status === "active";
}
