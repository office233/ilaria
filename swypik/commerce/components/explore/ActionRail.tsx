"use client";

import Link from "next/link";
import { EyeOff, MessageCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import type { FeedVideo } from "@/lib/feed/types";
import FollowButton from "@/components/social/FollowButton";
import LikeButton from "@/components/social/LikeButton";
import FeedSaveAction from "./actions/FeedSaveAction";
import FeedShareAction from "./actions/FeedShareAction";
import RailButton from "./actions/RailButton";
import { compactCount } from "./format";
import { withLike, withSave } from "./patches";

export type ActionRailProps = {
  video: FeedVideo;
  onPatch: (patch: (v: FeedVideo) => FeedVideo) => void;
  onFollowChange: (creatorId: string, following: boolean) => void;
  onOpenComments: () => void;
  onNotInterested: () => void;
};

/**
 * Coloana de acțiuni din dreapta: creator (+follow), like, comentarii, salvare, share, „nu mă interesează”.
 * Like/follow = componentele sociale comune (PUT/DELETE idempotente); starea confirmată
 * de server se scrie înapoi în payload-ul feed-ului (patches.ts).
 */
export default function ActionRail({ video, onPatch, onFollowChange, onOpenComments, onNotInterested }: ActionRailProps) {
  const t = useTranslations("explore");
  const locale = useLocale();
  const handle = video.creator.username || video.creator.id;
  const displayName = video.creator.name || video.creator.username || t("genericCreator");

  return (
    <div
      className="absolute right-2 z-20 flex flex-col items-center gap-3"
      style={{ bottom: "calc(var(--bottom-inset, 0px) + 1rem)", marginRight: "env(safe-area-inset-right, 0px)" }}
      role="group"
      aria-label={t("actiuniVideo")}
    >
      {video.creator.id ? (
        <div className="relative mb-3">
          <Link href={`/u/${encodeURIComponent(handle)}`} aria-label={t("openCreatorProfile", { name: displayName })} className="block rounded-full ring-2 ring-white">
            <Avatar src={video.creator.avatar} name={displayName} size="md" />
          </Link>
          <FollowButton
            variant="badge"
            userId={video.creator.id}
            initialFollowing={video.viewer.following}
            label={t("followCreator", { name: displayName })}
            onChange={(s) => onFollowChange(video.creator.id, s.following)}
            className="absolute -bottom-3 left-1/2 -translate-x-1/2 ring-2 ring-black"
          />
        </div>
      ) : null}
      <LikeButton
        variant="overlay"
        targetId={video.id}
        initialLiked={video.viewer.liked}
        initialCount={video.likes}
        onChange={(s) => onPatch(withLike(s))}
      />
      <RailButton
        label={t("discutii")}
        onClick={onOpenComments}
        count={compactCount(video.comments, locale)}
        icon={<MessageCircle aria-hidden />}
      />
      <FeedSaveAction
        videoId={video.id}
        saved={video.viewer.saved}
        count={video.saves}
        onChange={(s) => onPatch(withSave(s))}
      />
      <FeedShareAction videoId={video.id} count={video.shares} onShared={(count) => onPatch((v) => ({ ...v, shares: count }))} />
      <RailButton label={t("notInterested")} onClick={onNotInterested} icon={<EyeOff aria-hidden />} />
    </div>
  );
}
