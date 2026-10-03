"use client";

/** Aprobă / Respinge o cerere de revendicare (cu notă opțională). */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

export default function ClaimActions({ claimId }: { claimId: string }) {
  const t = useTranslations("foodAdmin");
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");

  async function review(action: "approve" | "reject") {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/merchant-claims/${claimId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() || undefined }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; code?: string } | null;
      if (!res.ok || !data?.success) {
        const code = data?.code ?? "server_error";
        toast({ title: t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.server_error"), tone: "danger" });
        return;
      }
      toast({ title: action === "approve" ? t("approved") : t("rejected"), tone: "success" });
      setRejectOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2 pt-1">
      <Button size="sm" loading={busy} onClick={() => review("approve")}>
        {t("approve")}
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejectOpen(true)}>
        {t("reject")}
      </Button>
      <Dialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={t("rejectTitle")}
        footer={
          <Button variant="danger" block loading={busy} onClick={() => review("reject")}>
            {t("reject")}
          </Button>
        }
      >
        <Textarea
          aria-label={t("rejectNote")}
          placeholder={t("rejectNote")}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </Dialog>
    </div>
  );
}
