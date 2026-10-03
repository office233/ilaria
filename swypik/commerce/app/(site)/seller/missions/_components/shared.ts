"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ManagedMission, ManagedSubmission } from "@/lib/missions/manage";
import type { missionLimits } from "@/lib/missions/config";

export type { ManagedMission, ManagedSubmission };
export type MissionLimits = ReturnType<typeof missionLimits>;

/** Sume în bani RON → „1.234,00 RON” (fondul de premii e mereu în RON). */
export function useFormatRon() {
  const locale = useLocale();
  return useCallback(
    (cents: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "RON" }).format(cents / 100),
    [locale],
  );
}

const KNOWN_ERRORS = new Set([
  "invalid_body",
  "seller_not_active",
  "product_not_owned",
  "rate_limited",
  "not_found",
  "already_funded",
  "invalid_pool",
  "payments_unavailable",
  "payment_failed",
  "invalid_transition",
  "video_not_published",
  "no_winner_slots",
  "escrow_insufficient",
  "mission_not_funded",
  "mission_closed",
  "self_dealing",
  "unpaid_winners",
  "already_closed",
  "refund_failed",
]);

/** Cod stabil de eroare din API → mesaj tradus (`sellerMissions.errors.*`). */
export function useErrorMessage() {
  const t = useTranslations("sellerMissions");
  return useCallback(
    (code: string | null | undefined) => (code && KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t("errors.generic")),
    [t],
  );
}

/** POST JSON; întoarce `{ ok, data }` fără să arunce la erori HTTP. */
export async function postJson<T>(url: string, body?: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: {} as T & { error?: string } };
  }
}

export async function fetchMissions(): Promise<ManagedMission[]> {
  const res = await fetch("/api/seller/missions", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { missions?: ManagedMission[] };
  return data.missions ?? [];
}

export const STATUS_TONE: Record<string, "neutral" | "success" | "info" | "warning"> = {
  draft: "neutral",
  active: "success",
  closed: "info",
  archived: "neutral",
};

export const FUNDING_TONE: Record<string, "neutral" | "success" | "info" | "warning"> = {
  unfunded: "warning",
  pending: "info",
  funded: "success",
  refunded: "neutral",
};

export function canFund(m: ManagedMission): boolean {
  return m.fundingSource === "seller" && m.status === "draft" && (m.fundingStatus === "unfunded" || m.fundingStatus === "pending");
}

export function canClose(m: ManagedMission): boolean {
  return m.status === "active" || m.status === "draft";
}
