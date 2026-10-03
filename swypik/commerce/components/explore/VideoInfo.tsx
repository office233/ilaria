"use client";

import Link from "next/link";
import { Music2 } from "lucide-react";
import { useTranslations } from "next-intl";
import VerifiedBadge from "@/components/VerifiedBadge";
import type { FeedVideo } from "@/lib/feed/types";
import MissionBadge from "./MissionBadge";
import ProductOverlay from "./ProductOverlay";

type Props = { video: FeedVideo; onOpenProduct: () => void };

/** Zona de jos-stânga: creator, descriere, sunet, misiune, produs. */
export default function VideoInfo({ video, onOpenProduct }: Props) {
  const t = useTranslations("explore");
  const handle = video.creator.username || video.creator.name || t("genericCreator");
  return (
    <div
      className="absolute left-0 z-20 flex flex-col gap-2 px-gutter"
      style={{ bottom: "calc(var(--bottom-inset, 0px) + 1rem)", right: "4.5rem" }}
    >
      {video.mission ? <MissionBadge mission={video.mission} /> : null}
      {video.creator.id ? (
        <Link
          href={`/u/${encodeURIComponent(video.creator.username || video.creator.id)}`}
          className="inline-flex min-h-11 w-fit items-center gap-1 text-base font-bold text-white drop-shadow"
        >
          @{handle}
          {video.creator.verified ? <VerifiedBadge size={14} /> : null}
        </Link>
      ) : null}
      {video.description ? (
        <p className="line-clamp-2 break-words text-sm leading-snug text-white/90 drop-shadow">{video.description}</p>
      ) : null}
      {video.audioTrack ? (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-white/85">
          <Music2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {[video.audioTrack.title, video.audioTrack.artist].filter(Boolean).join(" · ") || t("originalSound")}
          </span>
        </p>
      ) : null}
      {video.product ? <ProductOverlay videoId={video.id} product={video.product} onOpen={onOpenProduct} /> : null}
    </div>
  );
}
