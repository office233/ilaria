"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Check, Ban } from "lucide-react";
import { useRouter } from "next/navigation";

type Props = {
  orderId: string;
  blocked: boolean;
};

export function FraudActions({ orderId, blocked }: Props) {
  const t = useTranslations("adminRisk");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function decide(action: "approve" | "block") {
    if (busy || pending) return;
    const reason = prompt(
      action === "approve"
        ? t("approveReasonPrompt")
        : t("blockReasonPrompt"),
    );
    if (reason === null) return; // cancel
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/fraud-decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        alert(t("errorPrefix") + (data?.error || res.status));
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      alert(t("networkErrorPrefix") + (e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;
  return (
    <div className="flex gap-2 flex-wrap">
      {blocked ? (
        <button
          type="button"
          onClick={() => decide("approve")}
          disabled={disabled}
          className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-semibold disabled:opacity-50"
        >
          {disabled ? t("loading") : <span className="inline-flex items-center gap-1"><Check size={12} /> {t("approveUnblock")}</span>}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => decide("block")}
          disabled={disabled}
          className="text-xs px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700 font-semibold disabled:opacity-50"
        >
          {disabled ? t("loading") : <span className="inline-flex items-center gap-1"><Ban size={12} /> {t("blockManual")}</span>}
        </button>
      )}
    </div>
  );
}
