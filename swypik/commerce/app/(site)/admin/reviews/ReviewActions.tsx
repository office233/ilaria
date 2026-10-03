"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ui/ConfirmDialog";

type Props = {
  reviewId: string;
  isHidden: boolean;
};

export default function ReviewActions({ reviewId, isHidden }: Props) {
    const t = useTranslations("adminReviews");
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function run(action: "hide" | "unhide" | "delete") {
    if (loading !== null) return;
    setError(null);
    if (action === "hide") {
      const reason = prompt(t("hideReasonPrompt")) || undefined;
      setLoading(action);
      const res = await fetch(`/api/admin/reviews/${reviewId}/hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      setLoading(null);
      if (!res.ok) {
        setError(t("errorHide"));
        return;
      }
    } else if (action === "unhide") {
      setLoading(action);
      const res = await fetch(`/api/admin/reviews/${reviewId}/unhide`, { method: "POST" });
      setLoading(null);
      if (!res.ok) {
        setError(t("errorUnhide"));
        return;
      }
    } else {
      const ok = await confirm({
        title: t("confirmDelete"),
        description: t("confirmDeleteIrreversible"),
        confirmLabel: t("delete"),
        tone: "danger",
      });
      if (!ok) return;
      setLoading(action);
      const res = await fetch(`/api/admin/reviews/${reviewId}`, { method: "DELETE" });
      setLoading(null);
      if (!res.ok) {
        setError(t("errorDelete"));
        return;
      }
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-1">
      {isHidden ? (
        <button
          type="button"
          onClick={() => run("unhide")}
          disabled={loading !== null}
          className="px-2 py-1 text-xs rounded bg-green-100 text-green-800 hover:bg-green-200 disabled:opacity-50 inline-flex items-center gap-1"
          aria-label={t("reactivate")}
        >
          <Eye size={14} />
          {t("reactivate")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => run("hide")}
          disabled={loading !== null}
          className="px-2 py-1 text-xs rounded bg-yellow-100 text-yellow-800 hover:bg-yellow-200 disabled:opacity-50 inline-flex items-center gap-1"
          aria-label={t("hide")}
        >
          <EyeOff size={14} />
          {t("hide")}
        </button>
      )}
      <button
        type="button"
        onClick={() => run("delete")}
        disabled={loading !== null}
        className="px-2 py-1 text-xs rounded bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50 inline-flex items-center gap-1"
        aria-label={t("delete")}
      >
        <Trash2 size={14} />
        {t("delete")}
      </button>
      {error && <span className="text-xs text-red-600 ml-2">{error}</span>}
      {confirmDialog}
    </div>
  );
}
