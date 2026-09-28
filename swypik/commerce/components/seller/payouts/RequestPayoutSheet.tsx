"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  method: "stripe" | "bank";
  amountLabel: string;
  ibanMasked: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: (iban: string | null) => void;
};

/** Confirmarea cererii de retragere (IBAN nou opțional dacă există deja unul salvat). */
export function RequestPayoutSheet({ open, onOpenChange, method, amountLabel, ibanMasked, busy, error, onConfirm }: Props) {
  const t = useTranslations("sellerPanel.payouts");
  const [iban, setIban] = useState("");
  useEffect(() => {
    if (open) setIban("");
  }, [open]);
  const needsIban = method === "bank" && !ibanMasked;
  const canSubmit = !busy && (!needsIban || iban.trim().length >= 15);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("requestTitle")}
      description={method === "stripe" ? t("requestStripe", { amount: amountLabel }) : t("requestBank", { amount: amountLabel })}
      footer={
        <Button block loading={busy} disabled={!canSubmit} onClick={() => onConfirm(iban.trim() ? iban.trim() : null)}>
          {t("requestConfirm", { amount: amountLabel })}
        </Button>
      }
    >
      {method === "bank" ? (
        <TextField
          label={ibanMasked ? t("ibanChange") : t("iban")}
          hint={ibanMasked ? t("ibanSaved", { iban: ibanMasked }) : t("ibanHint")}
          value={iban}
          onChange={(e) => setIban(e.target.value)}
          autoComplete="off"
          inputMode="text"
          spellCheck={false}
          error={error ?? undefined}
        />
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : null}
    </Sheet>
  );
}
