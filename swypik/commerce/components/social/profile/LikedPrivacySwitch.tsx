"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";

/** Proprietarul decide dacă tab-ul „Apreciate" e vizibil și altora. */
export function LikedPrivacySwitch({ initial }: { initial: boolean }) {
  const t = useTranslations("social.profile");
  const { toast } = useToast();
  const id = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function change(next: boolean) {
    setValue(next);
    setBusy(true);
    try {
      const res = await fetch("/api/users/me/privacy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ liked_videos_public: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setValue(!next);
      toast({ title: t("actionError"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-gutter py-2">
      <label htmlFor={id} className="text-sm text-muted">
        {t("likedPublic")}
      </label>
      <Switch id={id} checked={value} disabled={busy} onCheckedChange={(v) => void change(v)} />
    </div>
  );
}
