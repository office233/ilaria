"use client";

import { useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import Image from "next/image";
import { Play, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

type Item = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  hiddenAt: string;
  reason: string;
};

const REASON_KEYS = new Set(["not_interested", "reported", "already_seen", "blocked_creator"]);

export default function HiddenVideosList({ initial }: { initial: Item[] }) {
  const t = useTranslations("hiddenVideos");
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function restore(videoId: string) {
    setBusy(videoId);
    try {
      const res = await fetch(`/api/videos/${videoId}/hidden`, { method: "DELETE" });
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.videoId !== videoId));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li
          key={i.videoId}
          className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3"
        >
          <Link
            href={`/video/${i.videoId}`}
            className="relative size-16 rounded-lg overflow-hidden bg-white/10 flex-shrink-0"
          >
            {i.thumbnailUrl ? (
              <Image
                src={i.thumbnailUrl}
                alt={i.title}
                fill
                sizes="64px"
                className="object-cover"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-white/40">
                <Play size={20} />
              </div>
            )}
          </Link>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold line-clamp-2">{i.title}</div>
            <div className="text-xs text-white/50">
              {REASON_KEYS.has(i.reason) ? t(`reason.${i.reason}`) : i.reason}
            </div>
          </div>
          <button
            onClick={() => restore(i.videoId)}
            disabled={busy === i.videoId}
            className="flex items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold hover:bg-white/[0.08] disabled:opacity-50"
            aria-label={t("restore")}
          >
            <RotateCcw size={14} />
            <span className="hidden md:inline">{t("restore")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
