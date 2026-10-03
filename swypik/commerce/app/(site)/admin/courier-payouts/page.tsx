"use client";

/**
 * FRONT R5 — Admin: cereri de retragere curieri (payout_requests).
 * Listă + aprobare (paid) / respingere (rejected, cu refund automat în wallet).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";

type Payout = {
  id: string;
  user_id: string;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "rejected";
  iban: string | null;
  admin_note: string | null;
  requested_at: string;
  resolved_at: string | null;
  email: string | null;
  display_name: string | null;
  balance_cents: number;
};

export default function CourierPayoutsAdminPage() {
  const t = useTranslations("adminCourierPayouts");
  const locale = useLocale();
  const [status, setStatus] = useState<string>("pending");
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const money = (cents: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "RON" }).format(cents / 100);
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });

  function translateApiError(code: string | undefined, fallback: string): string {
    switch (code) {
      case "unauthorized":
        return t("errUnauthorized");
      case "invalid_body":
        return t("errInvalidBody");
      case "payout_not_pending":
        return t("errNotPending");
      case "refund_failed":
        return t("errRefundFailed");
      default:
        return code || fallback;
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/courier-payouts${status ? `?status=${status}` : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(translateApiError(data.error, t("errLoadFailed")));
      setPayouts(data.payouts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errGeneric"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (id: string, action: "paid" | "rejected") => {
    if (busy) return; // double-submit protection
    const note = action === "rejected" ? window.prompt(t("rejectReasonPrompt")) ?? undefined : undefined;
    setBusy(id);
    try {
      const res = await fetch("/api/admin/courier-payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateApiError(data.error, t("errActionFailed")));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errGeneric"));
    } finally {
      setBusy(null);
    }
  };

  const tabs: { value: string; label: string }[] = [
    { value: "pending", label: t("tabPending") },
    { value: "paid", label: t("tabPaid") },
    { value: "rejected", label: t("tabRejected") },
    { value: "", label: t("tabAll") },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">{t("pageTitle")}</h1>

      <div className="flex gap-2 mb-4 flex-wrap">
        {tabs.map((tab) => (
          <button
            key={tab.value || "all"}
            onClick={() => setStatus(tab.value)}
            className={`px-3 py-1.5 rounded-lg text-sm border min-h-[40px] ${
              status === tab.value ? "bg-fg text-fg-inverse" : "bg-surface hover:bg-surface-2"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 p-3 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
      {loading ? (
        <div className="text-muted">{t("loading")}</div>
      ) : payouts.length === 0 ? (
        <div className="text-muted">{t("noRequests")}</div>
      ) : (
        <div className="overflow-x-auto border rounded-xl">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-surface-2 text-left">
              <tr>
                <th className="p-3">{t("thCourier")}</th>
                <th className="p-3">{t("thAmount")}</th>
                <th className="p-3">{t("thBalance")}</th>
                <th className="p-3">{t("thIban")}</th>
                <th className="p-3">{t("thRequestedAt")}</th>
                <th className="p-3">{t("statusLabel")}</th>
                <th className="p-3">{t("thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-3 max-w-[180px]">
                    <div className="font-medium truncate">{p.display_name || "—"}</div>
                    <div className="text-muted text-xs truncate">{p.email}</div>
                  </td>
                  <td className="p-3 font-semibold">{money(p.amount_cents)}</td>
                  <td className={`p-3 ${p.balance_cents < 0 ? "text-danger" : ""}`}>{money(p.balance_cents)}</td>
                  <td className="p-3 font-mono text-xs">{p.iban || "—"}</td>
                  <td className="p-3 text-muted whitespace-nowrap">{dateFmt.format(new Date(p.requested_at))}</td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        p.status === "pending"
                          ? "bg-warning-soft text-warning"
                          : p.status === "paid"
                            ? "bg-success-soft text-success"
                            : "bg-danger-soft text-danger"
                      }`}
                    >
                      {p.status}
                    </span>
                    {p.admin_note && <div className="text-xs text-subtle mt-1">{p.admin_note}</div>}
                  </td>
                  <td className="p-3">
                    {p.status === "pending" && (
                      <div className="flex gap-2">
                        <button
                          disabled={busy === p.id}
                          onClick={() => resolve(p.id, "paid")}
                          className="px-2.5 py-1 rounded-lg bg-success text-white text-xs disabled:opacity-50"
                        >
                          {t("markPaidBtn")}
                        </button>
                        <button
                          disabled={busy === p.id}
                          onClick={() => resolve(p.id, "rejected")}
                          className="px-2.5 py-1 rounded-lg bg-danger text-white text-xs disabled:opacity-50"
                        >
                          {t("rejectBtn")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
