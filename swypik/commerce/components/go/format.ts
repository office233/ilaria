"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";

/**
 * Formatare Swypik Go: sumele sunt în moneda REALĂ a cursei (nu convertite),
 * fiindcă asta se încasează.
 */
export function useGoFormat() {
  const locale = useLocale();
  return useMemo(
    () => ({
      money(cents: number | null | undefined, currency: string): string {
        if (cents == null) return "—";
        try {
          return new Intl.NumberFormat(locale, { style: "currency", currency: currency.trim() || "RON" }).format(cents / 100);
        } catch {
          return `${(cents / 100).toFixed(2)} ${currency}`;
        }
      },
      km(value: number | string | null | undefined): string {
        const n = Number(value ?? 0);
        return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
      },
      time(iso: string | null | undefined): string {
        if (!iso) return "—";
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
      },
    }),
    [locale],
  );
}

/** Codurile de eroare cunoscute ale API-ului Go → chei `go.errors.*`. */
const KNOWN_ERRORS = new Set([
  "no_zone",
  "active_ride",
  "payment_method_unavailable",
  "payment_not_authorized",
  "card_unavailable",
  "payment_failed",
  "bad_state",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "not_found",
  "offer_expired",
  "job_taken",
  "job_not_found",
  "courier_suspended",
  "not_approved_driver",
  "driver_unavailable",
  "driver_busy",
  "same_driver",
]);

export function goErrorKey(code: unknown): string {
  return typeof code === "string" && KNOWN_ERRORS.has(code) ? `errors.${code}` : "errors.generic";
}

/** fetch JSON cu eroare normalizată ({ error } din API). */
export async function goFetch<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init?.headers,
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: typeof body.error === "string" ? body.error : "generic" };
    return { ok: true, data: body };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}
