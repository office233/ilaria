"use client";

import { useRef, useState } from "react";
import { HeartHandshake } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { Link } from "@/lib/i18n/navigation";

const PRESETS = [500, 1000, 2500] as const;

export function LiveTipButton({ streamId, signedIn }: { streamId: string; signedIn: boolean }) {
  const t = useTranslations("live.tips");
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<number>(1000);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ amount: number; key: string } | null>(null);

  if (!signedIn) {
    return (
      <Button asChild variant="secondary" size="sm" className="pointer-events-auto">
        <Link href={`/auth?next=${encodeURIComponent(`/live/${streamId}`)}`}>
          <HeartHandshake className="h-4 w-4" aria-hidden /> {t("button")}
        </Link>
      </Button>
    );
  }

  const send = async () => {
    if (busy) return;
    const current =
      pending.current?.amount === amount
        ? pending.current
        : { amount, key: crypto.randomUUID() };
    pending.current = current;
    setBusy(true);
    try {
      const res = await fetch(`/api/live/streams/${streamId}/tip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents: current.amount,
          idempotencyKey: current.key,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        if (res.status < 500) pending.current = null;
        const key =
          data.error === "insufficient_balance"
            ? "insufficient"
            : data.error === "self_tip"
              ? "self"
              : data.error === "rate_limited"
                ? "rateLimited"
                : "failed";
        toast({ title: t(key), tone: "danger" });
        return;
      }
      pending.current = null;
      setOpen(false);
      toast({ title: t("sent"), tone: "success" });
    } catch {
      // Rezultatul poate fi incert după o întrerupere de rețea. Păstrăm aceeași
      // cheie pentru următorul tap ca retry-ul să fie idempotent.
      toast({ title: t("retrySame"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" className="pointer-events-auto" onClick={() => setOpen(true)}>
        <HeartHandshake className="h-4 w-4" aria-hidden /> {t("button")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("description")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void send()} disabled={busy}>
              {busy ? t("sending") : t("confirm", { amount: amount / 100 })}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setAmount(value);
                if (pending.current?.amount !== value) pending.current = null;
              }}
              aria-pressed={amount === value}
              className="min-h-11 rounded-control border border-subtle px-3 text-sm font-semibold aria-pressed:border-brand aria-pressed:bg-brand-soft"
            >
              {t("amount", { amount: value / 100 })}
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}
