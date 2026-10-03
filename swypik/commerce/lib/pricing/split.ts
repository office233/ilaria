/**
 * Split de bani — centralizat, folosit de FRONT R5 pentru wallet_ledger.
 *
 * Dintr-un total (cents) + procentele zonei → { platform, merchant, courier, tip }.
 * Invariant: platform + merchant + courier + tip === input (restul de rotunjire
 * merge la platformă, ca sumele să dea mereu exact totalul).
 *
 *  - delivery: items → merchant; delivery_fee → split courier/platform; tip → 100% curier
 *  - ride/errand: fare → split courier/platform; tip → 100% curier
 */

export type MoneySplit = {
  platform_cents: number;
  merchant_cents: number;
  courier_cents: number;
  tip_cents: number;
};

export type SplitInput = {
  /** Valoarea produselor (delivery). 0 pentru ride/errand. */
  items_cents?: number;
  /** Taxa de livrare / tariful cursei. */
  fee_cents: number;
  /** Bacșiș — merge integral la curier. */
  tip_cents?: number;
  /** Comision platformă pe items merchant (ex. 20.00). */
  platform_commission_pct: number;
  /** Cota curierului din fee (ex. 80.00). */
  courier_share_pct: number;
};

export function computeSplit(input: SplitInput): MoneySplit {
  const items = Math.max(0, Math.trunc(input.items_cents ?? 0));
  const fee = Math.max(0, Math.trunc(input.fee_cents));
  const tip = Math.max(0, Math.trunc(input.tip_cents ?? 0));

  // merchant: items minus comisionul platformei
  const platformFromItems = Math.round((items * input.platform_commission_pct) / 100);
  const merchant_cents = items - platformFromItems;

  // curier: cotă din fee
  const courier_cents = Math.round((fee * input.courier_share_pct) / 100);

  // platforma ia tot restul (inclusiv rotunjirile) → suma dă exact totalul
  const total = items + fee + tip;
  const platform_cents = total - merchant_cents - courier_cents - tip;

  return { platform_cents, merchant_cents, courier_cents, tip_cents: tip };
}
