"use client";

import { useCallback } from "react";
import { Bookmark } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/ui/cn";
import { trackEvent } from "@/lib/feed/track";
import { compactCount } from "../format";
import RailButton from "./RailButton";
import { postToggle, useToggleAction, type ToggleResult } from "./useToggleAction";

export type FeedSaveActionProps = {
  videoId: string;
  saved: boolean;
  count: number;
  onChange: (state: { saved: boolean; count: number }) => void;
};

/** Salvare în feed (POST /api/videos/[id]/save, toggle). */
export default function FeedSaveAction({ videoId, saved, count, onChange }: FeedSaveActionProps) {
  const t = useTranslations("explore");
  const locale = useLocale();
  const { toast } = useToast();
  const request = useCallback(async (): Promise<ToggleResult> => {
    const data = await postToggle(`/api/videos/${encodeURIComponent(videoId)}/save`);
    const on = Boolean(data.saved);
    trackEvent(on ? "save" : "unsave", { video_id: videoId });
    return { on, count: Number(data.save_count ?? count) || 0 };
  }, [videoId, count]);
  const { toggle, busy } = useToggleAction({
    on: saved,
    count,
    request,
    onChange: (s) => onChange({ saved: s.on, count: s.count }),
    onError: () => toast({ title: t("actionFailed"), tone: "danger" }),
    loginNext: `/explore?v=${videoId}`,
  });
  return (
    <RailButton
      label={saved ? t("unsave") : t("salveaza")}
      pressed={saved}
      busy={busy}
      onClick={toggle}
      count={compactCount(count, locale)}
      icon={<Bookmark aria-hidden className={cn(saved ? "fill-warning text-warning" : "fill-transparent")} />}
    />
  );
}
