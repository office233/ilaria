import { useTranslations } from "next-intl";
import { Badge, type BadgeProps } from "@/components/ui/Badge";

export type VideoDisplayStatus = "processing" | "ready" | "failed" | "draft" | "scheduled" | "archived";

/** Starea afișată a unui clip, din coloanele reale ale `videos`. */
export function deriveVideoStatus(v: {
  status: string;
  visibility?: string | null;
  isDraft?: boolean | null;
  scheduledPublishAt?: string | null;
}): VideoDisplayStatus {
  if (v.status === "failed") return "failed";
  if (v.status === "uploading" || v.status === "processing") return "processing";
  if (v.status === "archived") return "archived";
  if (v.isDraft || v.visibility === "draft") return "draft";
  if (v.scheduledPublishAt && v.visibility !== "public" && new Date(v.scheduledPublishAt).getTime() > Date.now()) {
    return "scheduled";
  }
  return "ready";
}

const TONE: Record<VideoDisplayStatus, NonNullable<BadgeProps["tone"]>> = {
  processing: "warning",
  ready: "success",
  failed: "danger",
  draft: "neutral",
  scheduled: "info",
  archived: "neutral",
};

/** Merge și în componente server, și client (next-intl `useTranslations`). */
export function VideoStatusBadge({ status, className }: { status: VideoDisplayStatus; className?: string }) {
  const t = useTranslations("creatorStudio.videoStatus");
  return (
    <Badge tone={TONE[status]} className={className}>
      {t(status)}
    </Badge>
  );
}
