"use client";

import { useLocale } from "next-intl";

/** Limitele misiunilor (din `missionLimits()` pe server), transmise formularului. */
export type MissionLimits = {
  minPrizeCents: number;
  maxPrizeCents: number;
  maxWinners: number;
  maxDurationDays: number;
  minDurationDays: number;
};

/** Forma `ManagedMission` din `lib/missions/manage.ts` (JSON de la API). */
export type AdminMission = {
  id: string;
  slug: string;
  title: string;
  brief: string | null;
  status: string;
  sellerId: string | null;
  sellerName: string | null;
  fundingSource: string;
  fundingStatus: string;
  prizeCents: number;
  maxWinners: number | null;
  poolCents: number;
  fundedCents: number;
  paidOutCents: number;
  refundedCents: number;
  escrowRemainingCents: number;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  submissions: number;
  winners: number;
};

/** Forma `ManagedSubmission` din `lib/missions/manage.ts`. */
export type AdminSubmission = {
  id: string;
  status: string;
  submittedAt: string;
  paidAt: string | null;
  payoutCents: number;
  rejectionReason: string | null;
  video: { id: string; title: string | null; thumbnailUrl: string | null; status: string | null; views: number };
  creator: { id: string; username: string | null; displayName: string | null };
};

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export const MISSION_STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  draft: "neutral",
  closed: "warning",
  archived: "neutral",
};

export const FUNDING_TONE: Record<string, BadgeTone> = {
  funded: "success",
  pending: "info",
  unfunded: "warning",
  refunded: "neutral",
};

export const SUBMISSION_TONE: Record<string, BadgeTone> = {
  submitted: "info",
  winner: "warning",
  paid: "success",
  rejected: "danger",
};

/** Codurile de eroare stabile pe care UI-ul le traduce (`errors.<code>`). */
export const KNOWN_ERRORS = new Set([
  "invalid_body",
  "invalid_params",
  "invalid_status",
  "not_found",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "internal_error",
  "unpaid_winners",
  "already_closed",
  "close_first",
  "refund_failed",
  "invalid_transition",
  "video_not_published",
  "no_winner_slots",
  "escrow_insufficient",
  "mission_not_funded",
  "mission_closed",
  "self_dealing",
  "product_not_owned",
]);

export function errorKey(code: unknown): string {
  return typeof code === "string" && KNOWN_ERRORS.has(code) ? `errors.${code}` : "errors.generic";
}

/** POST JSON; aruncă `Error(code)` pe răspuns ne-ok. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "generic");
  return data;
}

export function useFormatters() {
  const locale = useLocale();
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "RON" });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const num = new Intl.NumberFormat(locale);
  return {
    money: (cents: number) => money.format(cents / 100),
    date: (iso: string | null) => (iso ? date.format(new Date(iso)) : "—"),
    dateTime: (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "—"),
    num: (n: number) => num.format(n),
  };
}
