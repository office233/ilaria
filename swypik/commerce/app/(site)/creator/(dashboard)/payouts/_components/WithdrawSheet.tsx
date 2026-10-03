"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Input";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import { PAYOUT_ERROR_CODES, type PayoutsData } from "./types";

const FORM_ID = "creator-withdraw-form";

/** „12,50” / „12.5” → 1250; null dacă nu e un număr pozitiv cu max. 2 zecimale. */
function ronToCents(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: PayoutsData;
  onRequested: () => void;
};

export function WithdrawSheet({ open, onOpenChange, data, onRequested }: Props) {
  const t = useTranslations("creatorStudio.payouts");
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const money = (c: number) => formatMoneyCents(c, "RON", locale);
  const needsIban = data.readiness.method === "bank";

  const [amount, setAmount] = useState(() => String(Math.floor(data.balanceCents / 100)));
  const [iban, setIban] = useState("");
  const [busy, setBusy] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [ibanError, setIbanError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const errorText = (code: string) =>
    (PAYOUT_ERROR_CODES as readonly string[]).includes(code)
      ? t(`errors.${code}`, { min: money(data.readiness.minCents) })
      : t("errors.generic");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAmountError(null);
    setIbanError(null);
    setFormError(null);

    const cents = ronToCents(amount);
    if (cents === null) return setAmountError(t("errors.amount_invalid"));
    if (cents < data.readiness.minCents) return setAmountError(errorText("below_minimum"));
    if (cents > data.balanceCents) return setAmountError(errorText("insufficient_funds"));
    if (cents > data.balanceCents - (data.heldCents ?? 0)) return setAmountError(errorText("funds_on_hold"));
    const cleanIban = iban.replace(/\s+/g, "").toUpperCase();
    if (needsIban && !cleanIban) return setIbanError(errorText("iban_required"));

    setBusy(true);
    try {
      const res = await fetch("/api/creator/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(needsIban ? { amountCents: cents, iban: cleanIban } : { amountCents: cents }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const code = body.error ?? "generic";
        if (code === "invalid_iban" || code === "iban_required") setIbanError(errorText(code));
        else if (code === "below_minimum" || code === "insufficient_funds" || code === "funds_on_hold") setAmountError(errorText(code));
        else setFormError(errorText(code));
        return;
      }
      toast({ title: t("requestSent"), description: t("requestSentBody"), tone: "success" });
      onOpenChange(false);
      onRequested();
    } catch {
      setFormError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("withdrawTitle")}
      description={t("withdrawBody", { balance: money(data.balanceCents), min: money(data.readiness.minCents) })}
      footer={
        <Button type="submit" form={FORM_ID} block loading={busy}>
          {t("withdrawSubmit")}
        </Button>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="space-y-4 pt-2" noValidate>
        <TextField
          label={t("amountLabel")}
          hint={t("amountHint", { min: money(data.readiness.minCents) })}
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={amountError ?? undefined}
          required
        />
        {needsIban ? (
          <TextField
            label={t("ibanLabel")}
            hint={t("ibanHint")}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            error={ibanError ?? undefined}
            required
          />
        ) : null}
        {formError ? (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
