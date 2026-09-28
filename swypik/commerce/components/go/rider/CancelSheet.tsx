"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { cn } from "@/lib/ui/cn";
import { useGoFormat } from "../format";

const REASONS = ["wait_too_long", "wrong_address", "driver_not_coming", "changed_mind", "other"] as const;
export type CancelReason = (typeof REASONS)[number];

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Taxa calculată de server pentru momentul curent (cancel_policy.fee_cents_now). */
  feeCents: number;
  currency: string;
  busy: boolean;
  onConfirm: (reason: CancelReason, other: string) => void;
};

export default function CancelSheet({ open, onOpenChange, feeCents, currency, busy, onConfirm }: Props) {
  const t = useTranslations("go");
  const f = useGoFormat();
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [other, setOther] = useState("");

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("cancel.title")}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("cancel.keep")}
          </Button>
          <Button variant="danger" loading={busy} disabled={!reason} onClick={() => reason && onConfirm(reason, other)}>
            {t("cancel.confirm")}
          </Button>
        </div>
      }
    >
      <div role="radiogroup" aria-label={t("cancel.title")} className="space-y-2">
        {REASONS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              "flex min-h-[44px] w-full items-center rounded-control border px-3 text-left text-sm font-medium",
              reason === r ? "border-brand bg-brand-soft text-brand-soft-fg" : "border-subtle bg-surface text-fg",
            )}
          >
            {t(`cancel.${r}`)}
          </button>
        ))}
        {reason === "other" ? (
          <Textarea
            value={other}
            onChange={(e) => setOther(e.target.value)}
            maxLength={300}
            rows={2}
            placeholder={t("cancel.otherPlaceholder")}
            aria-label={t("cancel.other")}
          />
        ) : null}
      </div>
      <p
        className={cn(
          "mt-3 flex items-center gap-1.5 text-sm font-medium",
          feeCents > 0 ? "text-warning" : "text-success",
        )}
      >
        {feeCents > 0 ? <AlertTriangle aria-hidden className="h-4 w-4" /> : null}
        {feeCents > 0 ? t("cancel.feeWarning", { fee: f.money(feeCents, currency) }) : t("cancel.free")}
      </p>
    </Sheet>
  );
}
