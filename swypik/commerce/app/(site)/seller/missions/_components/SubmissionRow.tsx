"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Eye, Trophy, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose } from "@/components/ui/Dialog";
import { Field, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { postJson, useErrorMessage, useFormatRon, type ManagedSubmission } from "./shared";

type Props = {
  submission: ManagedSubmission;
  prizeCents: number;
  /** Premierea e posibilă (misiune activă, finanțată, cu locuri libere). */
  canPickWinner: boolean;
  onChanged: () => void;
};

const SUB_TONE: Record<string, "neutral" | "success" | "danger" | "info"> = {
  submitted: "neutral",
  winner: "info",
  paid: "success",
  rejected: "danger",
};

export function SubmissionRow({ submission: s, prizeCents, canPickWinner, onChanged }: Props) {
  const t = useTranslations("sellerMissions");
  const ron = useFormatRon();
  const errorMessage = useErrorMessage();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<"winner" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const creator = s.creator.displayName || (s.creator.username ? `@${s.creator.username}` : t("detail.unknownCreator"));

  const act = async (action: "winner" | "reject") => {
    setBusy(true);
    const { ok, data } = await postJson(`/api/seller/missions/submissions/${s.id}`, {
      action,
      ...(action === "reject" && reason.trim() ? { reason: reason.trim() } : {}),
    });
    setBusy(false);
    if (!ok) {
      toast({ title: errorMessage(data.error), tone: "danger" });
      return;
    }
    setDialog(null);
    setReason("");
    toast({ title: t(action === "winner" ? "detail.winnerDone" : "detail.rejectDone"), tone: "success" });
    onChanged();
  };

  const statusKey = s.status in SUB_TONE ? s.status : "submitted";

  return (
    <li className="rounded-control border border-subtle bg-surface p-2">
      <div className="flex gap-3">
        <Link href={`/video/${s.video.id}`} target="_blank" rel="noopener"
          className="relative h-20 w-14 shrink-0 overflow-hidden rounded-control bg-surface-2">
          {s.video.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.video.thumbnailUrl} alt={s.video.title ?? ""} loading="lazy" className="h-full w-full object-cover" />
          ) : null}
        </Link>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-fg">{s.video.title || t("detail.untitled")}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{creator}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={SUB_TONE[statusKey]} size="sm">{t(`submissionStatus.${statusKey}`)}</Badge>
            <span className="flex items-center gap-1 text-xs text-muted">
              <Eye className="h-3 w-3" aria-hidden /> {t("detail.views", { count: s.video.views })}
            </span>
            {s.status === "paid" ? <span className="text-xs font-semibold text-success">{ron(s.payoutCents)}</span> : null}
          </div>
          {s.status === "rejected" && s.rejectionReason ? (
            <p className="mt-1 text-xs text-muted">{t("detail.reasonShown", { reason: s.rejectionReason })}</p>
          ) : null}
        </div>
      </div>
      {s.status === "submitted" ? (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDialog("reject")}>
            <X className="h-4 w-4" aria-hidden /> {t("detail.reject")}
          </Button>
          <Button size="sm" disabled={!canPickWinner} onClick={() => setDialog("winner")}>
            <Trophy className="h-4 w-4" aria-hidden /> {t("detail.pickWinner")}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={dialog === "winner"}
        onOpenChange={(o) => setDialog(o ? "winner" : null)}
        title={t("detail.winnerTitle")}
        description={t("detail.winnerBody", { amount: ron(prizeCents), creator })}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t("detail.cancel")}</Button>
            </DialogClose>
            <Button loading={busy} onClick={() => void act("winner")}>
              {t("detail.winnerConfirm", { amount: ron(prizeCents) })}
            </Button>
          </>
        }
      />
      <Dialog
        open={dialog === "reject"}
        onOpenChange={(o) => setDialog(o ? "reject" : null)}
        title={t("detail.rejectTitle")}
        description={t("detail.rejectBody")}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t("detail.cancel")}</Button>
            </DialogClose>
            <Button variant="danger" loading={busy} onClick={() => void act("reject")}>
              {t("detail.rejectConfirm")}
            </Button>
          </>
        }
      >
        <Field label={t("detail.reasonLabel")} hint={t("detail.reasonHint")}>
          {(f) => <Textarea {...f} value={reason} maxLength={300} rows={3} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>
    </li>
  );
}
