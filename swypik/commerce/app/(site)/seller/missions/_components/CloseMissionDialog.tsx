"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogClose } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { postJson, useErrorMessage, useFormatRon, type ManagedMission } from "./shared";

type Props = {
  mission: ManagedMission;
  onClosed: () => void;
};

/** „Închide misiunea” — restul neplătit din escrow se returnează pe card. */
export function CloseMissionDialog({ mission, onClosed }: Props) {
  const t = useTranslations("sellerMissions");
  const ron = useFormatRon();
  const errorMessage = useErrorMessage();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = async () => {
    setBusy(true);
    const { ok, data } = await postJson<{ refundedCents?: number }>(`/api/seller/missions/${mission.id}/close`);
    setBusy(false);
    if (!ok) {
      toast({ title: errorMessage(data.error), tone: "danger" });
      return;
    }
    setOpen(false);
    toast({ title: t("close.done", { amount: ron(data.refundedCents ?? 0) }), tone: "success" });
    onClosed();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" block>
          {t("close.cta")}
        </Button>
      }
      title={t("close.title")}
      description={t("close.body", { amount: ron(mission.escrowRemainingCents) })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t("detail.cancel")}</Button>
          </DialogClose>
          <Button variant="danger" loading={busy} onClick={() => void close()}>
            {t("close.confirm")}
          </Button>
        </>
      }
    />
  );
}
