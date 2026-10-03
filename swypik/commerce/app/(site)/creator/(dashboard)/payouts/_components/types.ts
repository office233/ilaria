import type { PayoutReadiness, PayoutRequestView } from "@/lib/creator/payouts";

/** Forma răspunsului GET /api/creator/payouts. */
export type PayoutsData = {
  readiness: PayoutReadiness;
  balanceCents: number;
  /** Premii de misiune încă în perioada de reținere (nu se pot retrage). */
  heldCents: number;
  holdDays: number;
  payouts: PayoutRequestView[];
};

/** Codurile de eroare POST /api/creator/payouts cu mesaj dedicat (restul → `errors.generic`). */
export const PAYOUT_ERROR_CODES = [
  "below_minimum",
  "iban_required",
  "invalid_iban",
  "open_request_exists",
  "insufficient_funds",
  "funds_on_hold",
  "rate_limited",
  "invalid_body",
  "creator_required",
] as const;

export const OPEN_PAYOUT_STATUSES = ["pending", "processing"];
