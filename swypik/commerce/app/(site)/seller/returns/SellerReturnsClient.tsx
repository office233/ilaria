"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Check, X, ImageIcon } from "lucide-react";

type Row = {
  id: string;
  status: string;
  created_at: string;
  total_cents: number;
  currency: string;
  return_reason: string | null;
  return_requested_at: string | null;
  evidence_urls: string[];
  buyer_email: string | null;
};

const KNOWN_ERROR_CODES = new Set([
  "unauthorized",
  "not_found",
  "rate_limited",
  "invalid_status",
  "already_refunded",
  "order_not_owned",
  "multi_seller_requires_admin",
  "missing_payment_intent",
  "stripe_refund_failed",
  "server_error",
  "feature_frozen",
]);

function translateError(code: string | undefined | null, t: (key: string) => string): string {
  if (code && KNOWN_ERROR_CODES.has(code)) return t(`errors.${code}`);
  return code || t("errors.server_error");
}

export default function SellerReturnsClient({ initialRows }: { initialRows: Row[] }) {
  const t = useTranslations("sellerReturns");
  const locale = useLocale();
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept(id: string) {
    if (!confirm(t("confirmAccept"))) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/seller/orders/${id}/refund`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        setError(translateError(json.error, t));
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setError(t("errors.server_error"));
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: string) {
    const note = prompt(t("promptRejectReason")) || "";
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/seller/orders/${id}/return/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        setError(translateError(json.error, t));
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setError(t("errors.server_error"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex-1 px-4 md:px-6 py-6 max-w-5xl mx-auto pb-[max(24px,env(safe-area-inset-bottom))]">
      <header className="mb-6">
        <h1 className="text-2xl font-black text-[#0D0D0D]">{t("title")}</h1>
        <p className="mt-1 text-sm text-[#6E6E80]">{t("subtitle")}</p>
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-[#E5E5E5] bg-white p-10 text-center text-[#6E6E80]">
          {t("emptyState")}
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const requestedDate = r.return_requested_at ? new Date(r.return_requested_at) : new Date(r.created_at);
            const requested = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(requestedDate);
            const total = new Intl.NumberFormat(locale, { style: "currency", currency: r.currency || "RON" }).format(
              r.total_cents / 100
            );
            return (
              <li
                key={r.id}
                className="rounded-2xl border border-[#E5E5E5] bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black text-[#0D0D0D]">
                        {t("orderNumber", { id: r.id.slice(0, 8) })}
                      </span>
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-800">
                        {t("returnRequested")}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[#6E6E80]">
                      {t("requestedAt", { date: requested, total })}
                      {r.buyer_email ? ` · ${r.buyer_email}` : ""}
                    </p>
                    {r.return_reason && (
                      <p className="mt-2 line-clamp-3 text-sm text-[#0D0D0D]">
                        &ldquo;{r.return_reason}&rdquo;
                      </p>
                    )}
                    {Array.isArray(r.evidence_urls) && r.evidence_urls.length > 0 && (
                      <div className="mt-3 flex items-center gap-2">
                        <ImageIcon size={14} className="text-[#6E6E80]" />
                        <div className="flex gap-2">
                          {r.evidence_urls.slice(0, 4).map((u, i) => (
                            <a
                              key={u}
                              href={u}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block h-12 w-12 overflow-hidden rounded-lg border border-[#E5E5E5] bg-[#F7F7F8]"
                              aria-label={t("evidenceLink", { n: i + 1 })}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- evidență încărcată de cumpărător pe orice host extern, nu doar domenii Next Image configurate */}
                              <img src={u} alt={t("evidenceAlt", { n: i + 1 })} className="h-full w-full object-cover" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => accept(r.id)}
                      disabled={busy === r.id}
                      aria-label={t("acceptAria")}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#10A37F] px-4 py-2.5 min-h-[44px] text-xs font-bold text-white hover:bg-[#0e8e6e] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:outline-none"
                    >
                      <Check size={14} /> {t("acceptLabel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => reject(r.id)}
                      disabled={busy === r.id}
                      aria-label={t("rejectAria")}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#E5E5E5] px-4 py-2.5 min-h-[44px] text-xs font-bold text-[#0D0D0D] hover:bg-[#F7F7F8] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:outline-none"
                    >
                      <X size={14} /> {t("rejectLabel")}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
