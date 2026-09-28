"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2, X, Loader2, Send } from "lucide-react";

type Action = "delete" | "cancel-schedule" | "publish-now";

export default function DraftActions(props: {
  videoId: string;
  action: Action;
  label: string;
  icon: "trash" | "x" | "send";
  confirm: string;
}) {
  const { videoId, action, label, icon, confirm } = props;
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (typeof window !== "undefined" && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      if (action === "delete") {
        await fetch(`/api/creator/videos/${videoId}`, { method: "DELETE" });
      } else if (action === "cancel-schedule") {
        await fetch(`/api/creator/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publish: "draft" }),
        });
      } else if (action === "publish-now") {
        await fetch(`/api/creator/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publish: "public" }),
        });
      }
      router.refresh();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  const Icon = icon === "trash" ? Trash2 : icon === "send" ? Send : X;
  const publish = action === "publish-now";

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      aria-label={label}
      className={
        publish
          ? "h-11 px-3 rounded-lg bg-brand text-brand-fg text-xs font-bold flex items-center gap-1 hover:bg-brand-hover disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
          : "h-11 px-3 rounded-lg border border-subtle text-xs font-bold text-fg flex items-center gap-1 hover:bg-surface-2 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
      }
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
      {label}
    </button>
  );
}
