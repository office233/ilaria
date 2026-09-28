"use client";

import { CheckCircle2, CloudUpload, Loader2, RotateCcw, X, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/ui/cn";
import type { UploadStatus } from "@/lib/upload/api";
import type { UploadState } from "./useUploadController";
import { useErrorText } from "./useErrorText";

const MB = 1024 * 1024;

function Bar({ value, tone = "brand" }: { value: number | null; tone?: "brand" | "danger" }) {
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
    >
      {value === null ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-brand/60" />
      ) : (
        <div
          className={cn("h-full rounded-full transition-[width] duration-base", tone === "danger" ? "bg-danger" : "bg-brand")}
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      )}
    </div>
  );
}

/** Starea reală a uploadului și a procesării, cu anulare / reîncercare. */
export function UploadStatusCard(props: {
  state: UploadState;
  status: UploadStatus | null;
  trimConfirmed: boolean;
  onCancel: () => void;
  onRetry: () => void;
  className?: string;
}) {
  const { state, status, trimConfirmed, onCancel, onRetry, className } = props;
  const t = useTranslations("videoUpload.status");
  const errorText = useErrorText();

  if (state.kind === "idle" || state.kind === "cancelled") return null;

  let icon = <Loader2 className="h-5 w-5 animate-spin text-brand" aria-hidden />;
  let title = t("starting");
  let detail: string | null = null;
  let progress: number | null = null;
  let actions: React.ReactNode = null;

  switch (state.kind) {
    case "uploading": {
      const pct = state.total ? Math.floor((state.loaded / state.total) * 100) : 0;
      icon = <CloudUpload className="h-5 w-5 text-brand" aria-hidden />;
      title = t("uploading", { pct });
      detail = t("uploadedOf", { done: (state.loaded / MB).toFixed(1), total: (state.total / MB).toFixed(1) });
      progress = pct;
      actions = (
        <Button variant="ghost" size="md" onClick={onCancel}>
          <X className="h-4 w-4" aria-hidden /> {t("cancel")}
        </Button>
      );
      break;
    }
    case "uploaded":
      icon = <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />;
      title = t("uploaded");
      detail = trimConfirmed ? null : t("waitingForEdit");
      progress = 100;
      break;
    case "completing":
      title = t("finishing");
      break;
    case "processing":
      {
        const stageKey = `stage_${status?.stage ?? "queued"}`;
        title = t(t.has(stageKey) ? (stageKey as "stage_queued") : "stage_queued", { attempt: status?.attempts ?? 1 });
      }
      detail = t("processingHint");
      progress = status?.progress ?? null;
      break;
    case "ready":
      icon = <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />;
      title = t("ready");
      break;
    case "failed":
      icon = <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />;
      title = state.stage === "upload" ? t("uploadFailed") : t("processingFailed");
      detail = errorText(state.code);
      actions = (
        <div className="flex gap-2">
          {state.retryable ? (
            <Button variant="secondary" size="md" onClick={onRetry}>
              <RotateCcw className="h-4 w-4" aria-hidden /> {t("retry")}
            </Button>
          ) : null}
          {state.stage === "upload" ? (
            <Button variant="ghost" size="md" onClick={onCancel}>
              {t("discard")}
            </Button>
          ) : null}
        </div>
      );
      break;
  }

  return (
    <Card variant="muted" padding="sm" className={cn("space-y-2", className)} aria-live="polite">
      <div className="flex items-center gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{title}</p>
          {detail ? <p className="text-xs text-muted">{detail}</p> : null}
        </div>
        {actions}
      </div>
      {state.kind !== "ready" && state.kind !== "failed" ? <Bar value={progress} /> : null}
    </Card>
  );
}
