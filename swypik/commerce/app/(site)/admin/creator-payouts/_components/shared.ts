"use client";

import { useLocale } from "next-intl";

/** Rând din `GET /api/admin/creator-payouts` (int8 poate veni ca string din pg). */
export type CreatorPayoutRow = {
  id: string;
  user_id: string;
  amount_cents: number | string;
  status: string;
  iban: string | null;
  admin_note: string | null;
  failure_reason: string | null;
  requested_at: string;
  resolved_at: string | null;
  stripe_transfer_id: string | null;
  username: string | null;
  display_name: string | null;
  email: string | null;
  connect_ready: boolean | null;
  balance_cents: number | string;
};

export type PayoutAction = "paid" | "rejected";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export const PAYOUT_STATUSES = ["pending", "processing", "paid", "rejected", "failed"] as const;

export const PAYOUT_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  processing: "info",
  paid: "success",
  rejected: "neutral",
  failed: "danger",
};

const KNOWN_ERRORS = new Set([
  "not_pending",
  "nothing_to_pay",
  "transfer_failed",
  "iban_missing",
  "invalid_body",
  "invalid_status",
  "unauthorized",
  "forbidden",
  "internal_error",
]);

export function errorKey(code: unknown): string {
  return typeof code === "string" && KNOWN_ERRORS.has(code) ? `errors.${code}` : "errors.generic";
}

export function useFormatters() {
  const locale = useLocale();
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "RON" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  return {
    money: (cents: number | string) => money.format(Number(cents) / 100),
    dateTime: (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "—"),
  };
}
