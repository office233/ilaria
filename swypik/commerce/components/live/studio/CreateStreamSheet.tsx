"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Textarea, TextField, Field } from "@/components/ui/Input";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

/** Stream nou: titlu, descriere, dată opțională. După creare deschide studio-ul. */
export function CreateStreamSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("live.studio");
  const { toast } = useToast();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/live/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          scheduled_at: when ? new Date(when).toISOString() : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      if (!res.ok || !data.id) throw new Error(String(res.status));
      onOpenChange(false);
      router.push(`/creator/live/${data.id}`);
    } catch {
      toast({ title: t("createError"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("newStream")}
      footer={
        <Button block loading={busy} disabled={!title.trim()} onClick={() => void create()}>
          {t("create")}
        </Button>
      }
    >
      <div className="space-y-3 pb-2">
        <TextField label={t("titleLabel")} value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} required />
        <Field label={t("descriptionLabel")}>
          {(f) => <Textarea {...f} rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <TextField
          label={t("scheduleLabel")}
          hint={t("scheduleHint")}
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </div>
    </Sheet>
  );
}
