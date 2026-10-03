"use client";

import { useState } from "react";
import { Ban, EyeOff, Flag } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

/** Mesaj de chat așa cum vine prin SSE — fără user_id (doar nume afișat / avatar). */
export type ChatMsg = {
  id: number;
  message: string;
  username: string | null;
  display_name: string | null;
  avatar_url?: string | null;
};

type Action = "report" | "hide" | "ban";

/** Foaia de acțiuni pe un mesaj: raport (oricine autentificat), ascunde / blochează (gazda). */
export function ChatMessageActions({
  streamId,
  message,
  isHost,
  onClose,
}: {
  streamId: string;
  message: ChatMsg | null;
  isHost: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("live.chat");
  const { toast } = useToast();
  const [busy, setBusy] = useState<Action | null>(null);

  const run = async (action: Action) => {
    if (!message) return;
    setBusy(action);
    try {
      const path = action === "report" ? "report" : "moderate";
      const body = action === "report" ? { messageId: Number(message.id), reason: "other" } : { messageId: Number(message.id), action };
      const res = await fetch(`/api/live/streams/${streamId}/chat/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(res.ok ? { title: t(`done.${action}`), tone: "success" } : { title: t("actionFailed"), tone: "danger" });
      if (res.ok) onClose();
    } catch {
      toast({ title: t("actionFailed"), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={message !== null} onOpenChange={(open) => !open && onClose()} title={t("actionsTitle")} description={message?.message}>
      <div className="flex flex-col gap-2">
        <Button variant="secondary" loading={busy === "report"} onClick={() => run("report")}>
          <Flag className="h-4 w-4" aria-hidden /> {t("report")}
        </Button>
        {isHost ? (
          <>
            <Button variant="secondary" loading={busy === "hide"} onClick={() => run("hide")}>
              <EyeOff className="h-4 w-4" aria-hidden /> {t("hide")}
            </Button>
            <Button variant="danger" loading={busy === "ban"} onClick={() => run("ban")}>
              <Ban className="h-4 w-4" aria-hidden /> {t("ban")}
            </Button>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
