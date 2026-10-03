"use client";

/** Anularea comenzii de către client (doar înainte de confirmarea restaurantului). */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { readFoodError, useFoodError } from "../useFoodError";

type Props = { orderId: string; token: string | null; card: boolean; onDone: () => void };

export default function CancelOrderButton({ orderId, token, card, onDone }: Props) {
  const t = useTranslations("foodHub");
  const errorText = useFoodError();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch(`/api/local-orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "x-order-token": token } : {}) },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        toast({ title: errorText(await readFoodError(res)), tone: "danger" });
        return;
      }
      toast({ title: t("cancelDone"), tone: "success" });
      setOpen(false);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" block onClick={() => setOpen(true)}>{t("cancelOrder")}</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("cancelTitle")}
        description={card ? t("cancelCardNote") : t("cancelNote")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>{t("keepOrder")}</Button>
            <Button variant="danger" loading={busy} onClick={() => void cancel()}>{t("cancelConfirm")}</Button>
          </>
        }
      />
    </>
  );
}
