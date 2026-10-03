"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "./Button";
import { cn } from "@/lib/ui/cn";

export type ErrorStateProps = {
  title?: string;
  description?: string;
  /** Afișează butonul „Reîncearcă” dacă e setat. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

/** Stare de eroare pentru secțiuni/pagini: mesaj + „Reîncearcă”. Textele implicite vin din namespace-ul `ui`. */
export function ErrorState({ title, description, onRetry, retryLabel, className }: ErrorStateProps) {
  const t = useTranslations("ui");
  return (
    <div role="alert" className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle className="h-7 w-7" aria-hidden />
      </span>
      <p className="text-base font-semibold text-fg">{title ?? t("errorTitle")}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{description ?? t("errorBody")}</p>
      {onRetry ? (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          {retryLabel ?? t("retry")}
        </Button>
      ) : null}
    </div>
  );
}
