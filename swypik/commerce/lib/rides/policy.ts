/**
 * Swypik Go — reguli pure (fără I/O), sursa unică pentru server și teste.
 * UI-ul NU le duplică: primește rezultatul lor prin API (ex. `cancel_policy`).
 */
import type { GoSettings } from "./settings";

export type PaymentMethod = "card" | "cash";

/** Momentul până la care anularea de către pasager e gratuită (null = mereu gratuită acum). */
export function freeCancelUntil(acceptedAt: string | null, graceSeconds: number): Date | null {
  if (!acceptedAt) return null;
  return new Date(Date.parse(acceptedAt) + graceSeconds * 1000);
}

/**
 * Taxa de anulare: 0 înainte de accept sau în grația de după accept;
 * altfel taxa zonei. Doar pasagerul plătește (șoferul/adminul/sistemul nu).
 */
export function cancelFeeCents(args: {
  acceptedAt: string | null;
  zoneCancelFeeCents: number | null | undefined;
  graceSeconds: number;
  cancelledBy: "rider" | "driver" | "admin" | "system";
  now?: number;
}): number {
  if (args.cancelledBy !== "rider") return 0;
  const until = freeCancelUntil(args.acceptedAt, args.graceSeconds);
  if (!until) return 0;
  if ((args.now ?? Date.now()) <= until.getTime()) return 0;
  return Math.max(0, Math.trunc(args.zoneCancelFeeCents ?? 0));
}

/** Plafonul tarifului final: estimarea + cap (bps). Pasagerul nu plătește peste. */
export function maxFareCents(estimatedCents: number, capBps: number): number {
  return Math.round(estimatedCents * (1 + capBps / 10_000));
}

/**
 * Tariful final = tariful pe GPS, plafonat la estimare + cap. Dacă nu avem
 * estimare (date vechi) rămâne tariful calculat.
 */
export function capFinalFare(computedCents: number, estimatedCents: number | null, capBps: number): {
  final_cents: number;
  capped: boolean;
} {
  if (!estimatedCents || estimatedCents <= 0) return { final_cents: computedCents, capped: false };
  const max = maxFareCents(estimatedCents, capBps);
  return computedCents > max ? { final_cents: max, capped: true } : { final_cents: computedCents, capped: false };
}

/**
 * Suma autorizată pe card = plafonul tarifului + bacșiș. Aceeași cotă ca
 * plafonul final → capture-ul nu poate depăși niciodată autorizarea.
 */
export function authorizationAmountCents(estimatedCents: number, tipCents: number, capBps: number): number {
  return maxFareCents(estimatedCents, capBps) + Math.max(0, Math.trunc(tipCents));
}

/** Metodele de plată oferite pasagerului acum. */
export function allowedPaymentMethods(
  settings: Pick<GoSettings, "card_enabled" | "cash_enabled">,
  opts: { stripeConfigured: boolean; hasOwedFees: boolean },
): PaymentMethod[] {
  const out: PaymentMethod[] = [];
  if (settings.card_enabled && opts.stripeConfigured) out.push("card");
  // Taxă de anulare cash neachitată → doar card până la reglare.
  if (settings.cash_enabled && !opts.hasOwedFees) out.push("cash");
  return out;
}

/** Suma pe care șoferul o încasează cash la final (tarif + bacșiș). */
export function cashToCollectCents(ride: {
  payment_method: string;
  final_fare_cents: number | null;
  estimated_fare_cents: number | null;
  tip_cents?: number | null;
}): number {
  if (ride.payment_method !== "cash") return 0;
  return (ride.final_fare_cents ?? ride.estimated_fare_cents ?? 0) + Math.max(0, ride.tip_cents ?? 0);
}
