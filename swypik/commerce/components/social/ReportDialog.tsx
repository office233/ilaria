"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/ui/cn";
import { useAuthRedirect } from "./useAuthRedirect";

const REASONS = ["spam", "harassment", "hate", "violence", "sexual_content", "scam", "other"] as const;

export type ReportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: "user" | "comment";
  targetId: string;
};

/** Raportare utilizator/comentariu → moderation_reports (doar conturi reale). */
export default function ReportDialog({ open, onOpenChange, target, targetId }: ReportDialogProps) {
  const t = useTranslations("social.report");
  const { toast } = useToast();
  const toAuth = useAuthRedirect();
  const [reason, setReason] = useState<(typeof REASONS)[number] | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      const path = target === "user" ? "users" : "comments";
      const res = await fetch(`/api/${path}/${encodeURIComponent(targetId)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason, details: details.trim() || null }),
      });
      if (res.status === 401) {
        onOpenChange(false);
        toAuth();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      toast({ title: t("sent"), tone: "success" });
      setReason(null);
      setDetails("");
      onOpenChange(false);
    } catch {
      toast({ title: t("error"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={target === "user" ? t("titleUser") : t("titleComment")}
      description={t("description")}
      footer={
        <Button onClick={submit} disabled={!reason} loading={busy} block>
          {t("submit")}
        </Button>
      }
    >
      <div role="radiogroup" aria-label={t("reasonLabel")} className="flex flex-col gap-1">
        {REASONS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              "min-h-11 rounded-control px-3 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2",
              reason === r && "bg-brand-soft text-brand-soft-fg",
            )}
          >
            {t(`reasons.${r}`)}
          </button>
        ))}
      </div>
      <Textarea
        className="mt-3"
        rows={3}
        maxLength={500}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        placeholder={t("detailsPlaceholder")}
        aria-label={t("detailsPlaceholder")}
      />
    </Dialog>
  );
}
