"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export default function ApplicationActions({ applicationId }: { applicationId: string }) {
    const t = useTranslations("adminApplications");
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  function translateError(code: string | undefined, status: number): string {
    const known: Record<string, string> = {
      forbidden: t("errForbidden"),
      invalid_id: t("errInvalidId"),
      application_not_found: t("errApplicationNotFound"),
      already_approved: t("errAlreadyApproved"),
      already_rejected: t("errAlreadyRejected"),
      already_decided: t("errAlreadyDecided"),
      reason_required: t("reasonRequiredForRejection"),
    };
    if (code && known[code]) return known[code];
    return t("errorWithStatus", { status });
  }

  async function run(action: "approve" | "reject") {
    if (loading !== null) return;
    if (action === "reject" && !reason.trim()) {
      setError(t("reasonRequiredForRejection"));
      return;
    }
    const ok = await confirm({
      title: action === "approve" ? t("confirmApprove") : t("confirmReject"),
      confirmLabel: action === "approve" ? t("approve") : t("reject"),
      tone: action === "approve" ? "primary" : "danger",
    });
    if (!ok) return;
    setLoading(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/applications/${applicationId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(translateError(data?.error, res.status));
        setLoading(null);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorNetwork"));
      setLoading(null);
    }
  }

  return (
    <div>
      <label className="block text-xs font-bold text-black/60 uppercase mb-1">{t("reasonLabel")}</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm mb-2"
        placeholder={t("journalNotePlaceholder")}
      />
      {error && (
        <div className="mb-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={loading !== null}
          onClick={() => run("approve")}
          className="rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          {loading === "approve" ? t("loading") : t("approve")}
        </button>
        <button
          type="button"
          disabled={loading !== null}
          onClick={() => run("reject")}
          className="rounded-lg bg-red-600 text-white px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          {loading === "reject" ? t("loading") : t("reject")}
        </button>
      </div>
      {confirmDialog}
    </div>
  );
}
