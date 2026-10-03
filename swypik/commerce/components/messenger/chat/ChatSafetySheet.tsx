"use client";

import { useState } from "react";
import { Ban, Flag, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { DM_REPORT_REASONS, type DmReportReason } from "@/lib/dm/config";
import { cn } from "@/lib/ui/cn";
import type { ConversationDetail } from "../types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  detail: ConversationDetail;
  onBlockedChange: (blocked: boolean) => void;
};

/** Profil, blocare/deblocare și raportare a interlocutorului. */
export function ChatSafetySheet({ open, onOpenChange, conversationId, detail, onBlockedChange }: Props) {
  const t = useTranslations("dm.safety");
  const { toast } = useToast();
  const [mode, setMode] = useState<"menu" | "report" | "confirmBlock">("menu");
  const [reason, setReason] = useState<DmReportReason>("spam");
  const [busy, setBusy] = useState(false);
  const peerId = detail.peer?.user_id;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setMode("menu");
  };

  const toggleBlock = async () => {
    if (!peerId) return;
    setBusy(true);
    const blocking = !detail.blocked_by_me;
    try {
      const res = await fetch("/api/dm/blocks", {
        method: blocking ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: peerId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onBlockedChange(blocking);
      toast({ title: blocking ? t("blockedToast") : t("unblockedToast"), tone: "success" });
      close(false);
    } catch {
      toast({ title: t("error"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/dm/conversations/${conversationId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast({ title: t("reportedToast"), tone: "success" });
      close(false);
    } catch {
      toast({ title: t("error"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const footer =
    mode === "report" ? (
      <Button block loading={busy} onClick={submitReport}>
        {t("sendReport")}
      </Button>
    ) : mode === "confirmBlock" ? (
      <Button block variant={detail.blocked_by_me ? "secondary" : "danger"} loading={busy} onClick={toggleBlock}>
        {detail.blocked_by_me ? t("unblock") : t("block")}
      </Button>
    ) : undefined;

  return (
    <Sheet
      open={open}
      onOpenChange={close}
      title={mode === "report" ? t("reportTitle") : mode === "confirmBlock" ? t("blockTitle") : t("title")}
      description={mode === "confirmBlock" && !detail.blocked_by_me ? t("blockDescription") : undefined}
      footer={footer}
    >
      {mode === "menu" ? (
        <div className="space-y-1 pb-2">
          {detail.peer?.username ? (
            <ListItem icon={UserRound} title={t("viewProfile")} href={`/u/${detail.peer.username}`} />
          ) : null}
          <ListItem
            icon={Ban}
            title={detail.blocked_by_me ? t("unblock") : t("block")}
            onClick={() => setMode("confirmBlock")}
          />
          <ListItem icon={Flag} title={t("report")} onClick={() => setMode("report")} />
        </div>
      ) : null}
      {mode === "report" ? (
        <fieldset className="space-y-1 pb-2">
          <legend className="mb-2 text-sm text-muted">{t("reportReasonLegend")}</legend>
          {DM_REPORT_REASONS.map((r) => (
            <label
              key={r}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-sm",
                reason === r ? "bg-brand-soft text-brand-soft-fg" : "hover:bg-surface-2",
              )}
            >
              <input type="radio" name="dm-report-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
              {t(`reasons.${r}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
    </Sheet>
  );
}
