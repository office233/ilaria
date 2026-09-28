"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Inbox } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { SubmissionRow, type JudgeKind } from "./SubmissionRow";
import { errorKey, postJson, useFormatters, type AdminMission, type AdminSubmission } from "./shared";

type Props = {
  mission: AdminMission | null;
  onOpenChange: (open: boolean) => void;
  /** Reîncarcă lista după o acțiune care schimbă cifrele misiunii. */
  onChanged: () => void;
};

type Pending =
  | { kind: JudgeKind; submission: AdminSubmission }
  | { kind: "close" | "archive" }
  | null;

/** Detaliul unei misiuni: înscrieri, jurizare (câștigător = plată), închidere/arhivare. */
export function MissionDetailSheet({ mission, onOpenChange, onChanged }: Props) {
  const t = useTranslations("adminMissions");
  const f = useFormatters();
  const { toast } = useToast();
  const [subs, setSubs] = useState<AdminSubmission[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const id = mission?.id ?? null;

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(false);
    setSubs(null);
    try {
      const res = await fetch(`/api/admin/missions/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("load");
      const data = (await res.json()) as { submissions?: AdminSubmission[] };
      setSubs(data.submissions ?? []);
    } catch {
      setLoadError(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function ask(p: Pending) {
    setActionError(null);
    setPending(p);
  }

  async function confirm(note: string) {
    if (!pending || !mission || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      if (!("submission" in pending)) {
        const res = await postJson<{ refundedCents?: number }>(`/api/admin/missions/${mission.id}`, {
          action: pending.kind,
        });
        toast({
          title:
            pending.kind === "close"
              ? t("toast.closed", { amount: f.money(res.refundedCents ?? 0) })
              : t("toast.archived"),
          tone: "success",
        });
        setPending(null);
        onChanged();
        if (pending.kind === "archive") onOpenChange(false);
        return;
      }
      await postJson("/api/admin/missions/submissions", {
        submissionId: pending.submission.id,
        action: pending.kind,
        ...(pending.kind === "reject" && note ? { reason: note } : {}),
      });
      toast({ title: t(pending.kind === "reject" ? "toast.rejected" : "toast.paid"), tone: "success" });
      setPending(null);
      onChanged();
      await load();
    } catch (err) {
      setActionError(t(errorKey(err instanceof Error ? err.message : null)));
    } finally {
      setBusy(false);
    }
  }

  const status = mission?.status ?? "";
  const judgeable = status === "active";
  const canClose = status === "active" || status === "draft";
  const canArchive =
    status !== "archived" &&
    (status === "closed" || mission?.fundingStatus === "unfunded" || mission?.fundingStatus === "refunded");
  const creatorOf = (s: AdminSubmission) =>
    s.creator.displayName || (s.creator.username ? `@${s.creator.username}` : t("unknownCreator"));

  const dialog = (() => {
    if (!pending || !mission) return null;
    if (pending.kind === "close") {
      return { title: t("confirm.closeTitle"), body: t("confirm.closeBody", { amount: f.money(mission.escrowRemainingCents) }), label: t("actions.close"), tone: "danger" as const };
    }
    if (pending.kind === "archive") {
      return { title: t("confirm.archiveTitle"), body: t("confirm.archiveBody"), label: t("actions.archive"), tone: "danger" as const };
    }
    if (!("submission" in pending)) return null;
    const who = creatorOf(pending.submission);
    if (pending.kind === "reject") {
      return { title: t("confirm.rejectTitle"), body: t("confirm.rejectBody", { creator: who }), label: t("actions.reject"), tone: "danger" as const, note: t("confirm.reasonLabel") };
    }
    return {
      title: t(pending.kind === "pay" ? "confirm.payTitle" : "confirm.winnerTitle"),
      body: t("confirm.winnerBody", { creator: who, amount: f.money(mission.prizeCents) }),
      label: t(pending.kind === "pay" ? "actions.pay" : "actions.winnerConfirm"),
      tone: "primary" as const,
    };
  })();

  return (
    <Sheet
      open={mission !== null}
      onOpenChange={onOpenChange}
      side="right"
      className="w-full max-w-xl"
      title={mission?.title ?? ""}
      description={mission ? t("detailSubtitle", { prize: f.money(mission.prizeCents), winners: mission.winners, max: mission.maxWinners ?? 0 }) : undefined}
      footer={
        canClose || canArchive ? (
          <div className="flex flex-wrap gap-2">
            {canClose ? (
              <Button variant="secondary" className="flex-1" onClick={() => ask({ kind: "close" })}>
                {t("actions.close")}
              </Button>
            ) : null}
            {canArchive ? (
              <Button variant="secondary" className="flex-1" onClick={() => ask({ kind: "archive" })}>
                {t("actions.archive")}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {mission ? (
        <div className="space-y-4">
          {mission.brief ? <p className="whitespace-pre-line text-sm text-muted">{mission.brief}</p> : null}
          <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
            {t("escrowLine", { remaining: f.money(mission.escrowRemainingCents), funded: f.money(mission.fundedCents) })}
          </p>
          <h3 className="text-sm font-semibold text-fg">{t("submissionsTitle", { count: subs?.length ?? mission.submissions })}</h3>
          {loadError ? (
            <ErrorState description={t("errors.loadSubmissions")} onRetry={() => void load()} />
          ) : subs === null ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-28 w-full rounded-card" />
              ))}
            </div>
          ) : subs.length === 0 ? (
            <EmptyState icon={Inbox} title={t("noSubmissions")} description={t("noSubmissionsHint")} />
          ) : (
            <ul className="space-y-3">
              {subs.map((s) => (
                <SubmissionRow key={s.id} submission={s} judgeable={judgeable} onAction={(kind) => ask({ kind, submission: s })} />
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {dialog ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setPending(null))}
          title={dialog.title}
          description={dialog.body}
          confirmLabel={dialog.label}
          tone={dialog.tone}
          noteLabel={"note" in dialog ? dialog.note : undefined}
          busy={busy}
          error={actionError}
          onConfirm={(note) => void confirm(note)}
        />
      ) : null}
    </Sheet>
  );
}
