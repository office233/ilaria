"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Eye, PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SUBMISSION_TONE, useFormatters, type AdminSubmission } from "./shared";

export type JudgeKind = "winner" | "reject" | "pay";

const SUB_STATUSES = new Set(["submitted", "winner", "paid", "rejected"]);

type Props = {
  submission: AdminSubmission;
  /** Misiunea poate primi încă decizii (activă/închisă, nu arhivată). */
  judgeable: boolean;
  onAction: (kind: JudgeKind) => void;
};

/** Un rând de înscriere: clip, creator, stare, acțiuni de jurizare. */
export function SubmissionRow({ submission: s, judgeable, onAction }: Props) {
  const t = useTranslations("adminMissions");
  const f = useFormatters();
  const status = SUB_STATUSES.has(s.status) ? s.status : "unknown";
  const creatorName = s.creator.displayName || (s.creator.username ? `@${s.creator.username}` : t("unknownCreator"));
  const canPick = judgeable && s.status === "submitted";
  const canPay = judgeable && (s.status === "winner" || s.status === "approved");
  const canReject = judgeable && ["submitted", "winner", "approved"].includes(s.status);

  return (
    <li className="rounded-card border border-subtle bg-surface p-3">
      <div className="flex items-start gap-3">
        <Link
          href={`/video/${s.video.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="relative grid h-20 w-14 shrink-0 place-items-center overflow-hidden rounded-control bg-surface-2"
          aria-label={t("openVideo")}
        >
          {s.video.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.video.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <PlayCircle aria-hidden className="h-6 w-6 text-subtle" />
          )}
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SUBMISSION_TONE[s.status] ?? "neutral"}>{t(`subStatus.${status}`)}</Badge>
            {s.video.status && s.video.status !== "ready" ? (
              <Badge tone="warning">{t("videoNotReady")}</Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm font-semibold text-fg">{s.video.title || t("untitledVideo")}</p>
          <p className="truncate text-sm text-muted">{creatorName}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-subtle">
            <span className="inline-flex items-center gap-1">
              <Eye aria-hidden className="h-3.5 w-3.5" />
              {t("views", { count: s.video.views })}
            </span>
            <span>{t("submittedAt", { date: f.dateTime(s.submittedAt) })}</span>
          </p>
          {s.status === "paid" ? (
            <p className="mt-1 text-sm font-semibold text-success">
              {t("paidAmount", { amount: f.money(s.payoutCents), date: f.dateTime(s.paidAt) })}
            </p>
          ) : null}
          {s.status === "rejected" && s.rejectionReason ? (
            <p className="mt-1 text-sm text-muted">{t("rejectedReason", { reason: s.rejectionReason })}</p>
          ) : null}
        </div>
      </div>
      {canPick || canPay || canReject ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {canPick ? (
            <Button size="sm" className="min-h-11 sm:min-h-9" onClick={() => onAction("winner")}>
              {t("actions.winner")}
            </Button>
          ) : null}
          {canPay ? (
            <Button size="sm" className="min-h-11 sm:min-h-9" onClick={() => onAction("pay")}>
              {t("actions.pay")}
            </Button>
          ) : null}
          {canReject ? (
            <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-9" onClick={() => onAction("reject")}>
              {t("actions.reject")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
