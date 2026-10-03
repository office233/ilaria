"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Clock, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { ApplicationView } from "@/lib/creator/application";

/** Starea aplicării: în analiză (pending) sau respinsă (cu nota adminului). */
export function ApplicationStatusCard({ kind, application }: { kind: "pending" | "rejected"; application: ApplicationView }) {
  const t = useTranslations("becomeCreatorForm.status");
  const format = useFormatter();
  const pending = kind === "pending";
  const Icon = pending ? Clock : XCircle;

  return (
    <Card role="status" padding="lg">
      <div className="flex items-start gap-3">
        <span
          className={
            pending
              ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"
              : "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger"
          }
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-fg">{pending ? t("pendingTitle") : t("rejectedTitle")}</h2>
            <Badge tone={pending ? "warning" : "danger"}>{pending ? t("pendingBadge") : t("rejectedBadge")}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{pending ? t("pendingBody") : t("rejectedBody")}</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">{t("handle")}</dt>
            <dd className="truncate font-medium text-fg">@{application.handle}</dd>
            <dt className="text-muted">{t("submitted")}</dt>
            <dd className="font-medium text-fg">{format.dateTime(new Date(application.createdAt), { dateStyle: "medium" })}</dd>
          </dl>
          {!pending && application.reviewNote ? (
            <div className="mt-3 rounded-control bg-surface-2 p-3">
              <p className="text-xs font-semibold text-muted">{t("reviewNote")}</p>
              <p className="mt-1 whitespace-pre-line break-words text-sm text-fg">{application.reviewNote}</p>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
