"use client";

import { useState } from "react";
import { Pencil, Share2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Link } from "@/lib/i18n/navigation";
import { formatCount } from "@/lib/social/format";
import type { ProfileStats } from "@/lib/social/profile/stats";
import FollowButton from "../FollowButton";
import { MessageButton } from "@/components/messenger/MessageButton";
import { FollowListSheet, type FollowDirection } from "./FollowListSheet";
import { useShareProfile } from "./useShareProfile";

export type ProfileSocialBarProps = {
  userId: string;
  username: string;
  displayName: string;
  isOwnProfile: boolean;
  initialFollowing: boolean;
  stats: ProfileStats;
  /** Profil restrâns (blocare): fără follow și fără liste. */
  restricted?: boolean;
};

/** Cifrele profilului (urmăritori/urmăriri deschid lista) + acțiunile principale. */
export function ProfileSocialBar({
  userId,
  username,
  displayName,
  isOwnProfile,
  initialFollowing,
  stats,
  restricted = false,
}: ProfileSocialBarProps) {
  const t = useTranslations("social.profile");
  const locale = useLocale();
  const share = useShareProfile(username, displayName);
  const [followers, setFollowers] = useState(stats.followers);
  const [list, setList] = useState<FollowDirection | null>(null);

  const items: { key: string; label: string; value: number; open?: FollowDirection }[] = [
    { key: "following", label: t("following"), value: stats.following, open: "following" },
    { key: "followers", label: t("followers"), value: followers, open: "followers" },
    { key: "likes", label: t("likes"), value: stats.likes },
    { key: "videos", label: t("videos"), value: stats.videos },
  ];

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="grid w-full max-w-sm grid-cols-4">
        {items.map((item) => {
          const content = (
            <>
              <span className="text-base font-bold text-fg">{formatCount(item.value, locale)}</span>
              <span className="text-xs text-muted">{item.label}</span>
            </>
          );
          return item.open && !restricted ? (
            <button
              key={item.key}
              type="button"
              onClick={() => setList(item.open ?? null)}
              className="flex min-h-11 flex-col items-center justify-center rounded-control hover:bg-surface-2"
            >
              {content}
            </button>
          ) : (
            <div key={item.key} className="flex min-h-11 flex-col items-center justify-center">
              {content}
            </div>
          );
        })}
      </div>

      {restricted ? null : (
        <div className="flex w-full max-w-sm items-center gap-2">
          {isOwnProfile ? (
            <Button asChild variant="secondary" className="flex-1">
              <Link href="/account/edit">
                <Pencil aria-hidden className="h-4 w-4" />
                {t("editProfile")}
              </Link>
            </Button>
          ) : (
            <FollowButton
              userId={userId}
              initialFollowing={initialFollowing}
              initialFollowerCount={stats.followers}
              onChange={(s) => setFollowers(s.followerCount)}
              className="flex-1"
            />
          )}
          {isOwnProfile ? null : <MessageButton entry={{ kind: "user", id: userId }} appearance="icon" />}
          <IconButton label={t("share")} variant="secondary" onClick={() => void share()}>
            <Share2 aria-hidden />
          </IconButton>
        </div>
      )}

      <FollowListSheet userId={userId} username={username} open={list} onOpenChange={setList} />
    </div>
  );
}
