"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Textarea } from "@/components/ui/Input";
import { useFormatters, type CreatorPayoutRow, type PayoutAction } from "./shared";

type Props = {
  target: { payout: CreatorPayoutRow; action: PayoutAction } | null;
  connectAvailable: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
  ns?: string;
};

/** Confirmare „Marchează plătit” / „Respinge”, cu notă opțională. */
export function ResolvePayoutDialog({ target, connectAvailable, busy, error, onCancel, onConfirm, ns = "adminCreatorPayouts" }: Props) {
  const t = useTranslations(ns);
  const f = useFormatters();
  const [note, setNote] = useState("");

  useEffect(() => {
    if (target) setNote("");
  }, [target]);

  if (!target) return null;
  const { payout: p, action } = target;
  const name = p.display_name || (p.username ? `@${p.username}` : t("unknownCreator"));
  const amount = f.money(p.amount_cents);
  const viaStripe = connectAvailable && p.connect_ready === true;

  const description =
    action === "rejected"
      ? t("confirm.rejectBody", { amount, creator: name })
      : viaStripe
        ? t("confirm.paidStripeBody", { amount, creator: name })
        : t("confirm.paidBankBody", { amount, creator: name, iban: p.iban || t("noIban") });

  return (
    <Dialog
      open
      onOpenChange={(open) => (open || busy ? undefined : onCancel())}
      title={action === "rejected" ? t("confirm.rejectTitle") : t("confirm.paidTitle")}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant={action === "rejected" ? "danger" : "primary"}
            loading={busy}
            disabled={busy}
            onClick={() => onConfirm(note.trim())}
          >
            {action === "rejected" ? t("actions.reject") : t("actions.markPaid")}
          </Button>
        </>
      }
    >
      <Field label={t("noteLabel")} hint={t("noteHint")}>
        {(fp) => (
          <Textarea {...fp} value={note} rows={3} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        )}
      </Field>
      {error ? (
        <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
