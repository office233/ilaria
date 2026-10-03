/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Calendar, Eye, Package, Play, Video } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { VideoStatusBadge, deriveVideoStatus } from "../../_components/VideoStatusBadge";

export interface CreatorVideo {
  id: string;
  status: string;
  visibility?: string | null;
  video_url: string | null;
  thumbnail_url?: string | null;
  description: string | null;
  created_at: string;
  product_title: string | null;
  product_id: string | null;
  product_image: string | null;
  view_count?: number | string | null;
}

export function VideoCard({ video }: { video: CreatorVideo }) {
  const t = useTranslations("creatorStudio.videos");
  const format = useFormatter();
  const status = deriveVideoStatus({ status: video.status, visibility: video.visibility });
  const cover = video.thumbnail_url || video.product_image;
  const playable = status === "ready" && Boolean(video.video_url);

  const media = (
    <div className="relative aspect-[9/16] max-h-72 w-full overflow-hidden bg-surface-2">
      {cover ? (
        <img
          src={cover}
          alt={video.product_title ?? t("altVideo")}
          className="h-full w-full object-cover transition-transform duration-slow group-hover:scale-105"
          loading="lazy"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-subtle">
          <Video className="h-10 w-10" aria-hidden />
          <span className="text-xs font-medium">{t("noPreview")}</span>
        </div>
      )}
      <div className="absolute left-2 top-2">
        <VideoStatusBadge status={status} />
      </div>
      {playable ? (
        <div className="absolute inset-0 flex items-center justify-center bg-overlay/30 opacity-0 transition-opacity duration-base group-hover:opacity-100">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface/90 text-fg shadow-elev-2">
            <Play className="ml-0.5 h-5 w-5" aria-hidden />
          </span>
        </div>
      ) : null}
    </div>
  );

  return (
    <Card padding="none" className="group flex flex-col overflow-hidden">
      {playable ? (
        <Link href={`/video/${video.id}`} aria-label={t("watch")}>
          {media}
        </Link>
      ) : (
        media
      )}
      <div className="flex flex-1 flex-col gap-2 p-3">
        {video.product_title ? (
          <p className="flex items-start gap-1.5 text-sm font-semibold leading-tight text-fg">
            <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
            <span className="line-clamp-2">{video.product_title}</span>
          </p>
        ) : null}
        {video.description ? <p className="line-clamp-2 text-xs text-muted">{video.description}</p> : null}
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-subtle pt-2 text-xs text-muted">
          <span className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" aria-hidden />
            {format.dateTime(new Date(video.created_at), { dateStyle: "medium" })}
          </span>
          {video.view_count != null ? (
            <span className="flex items-center gap-1 tabular-nums">
              <Eye className="h-3.5 w-3.5" aria-hidden />
              {format.number(Number(video.view_count))}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
