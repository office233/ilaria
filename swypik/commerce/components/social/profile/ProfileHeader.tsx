import { BadgeCheck, Link2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import LevelBadge from "@/components/gaming/LevelBadge";
import type { LevelBadge as LevelBadgeData } from "@/lib/gaming/level";
import type { PublicUserProfile } from "@/lib/social/user-profile";

type Props = {
  locale: string;
  profile: PublicUserProfile["profile"];
  badges: PublicUserProfile["badges"];
  /** Nivelul XP (Swypik Arcade) — doar când FEATURE_GAMING e pornit (getProfileLevelBadge). */
  level?: LevelBadgeData | null;
};

const LEVEL_KEYS = { bronze: "badgeLevelBronze", silver: "badgeLevelSilver", gold: "badgeLevelGold" } as const;

/** Antetul profilului (server): avatar, nume, handle, insigne, bio, linkuri, categorii. */
export async function ProfileHeader({ locale, profile, badges, level }: Props) {
  const t = await getTranslations({ locale, namespace: "social.profile" });
  const tp = await getTranslations({ locale, namespace: "userProfile" });

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <Avatar src={profile.avatarUrl} name={profile.displayName} size="xl" className="h-24 w-24 text-3xl" />
      <div className="flex items-center gap-1.5">
        <h1 className="text-xl font-bold text-fg">{profile.displayName}</h1>
        {profile.isVerified ? <BadgeCheck className="h-5 w-5 text-brand" aria-label={tp("verifiedProfile")} /> : null}
      </div>
      <p className="text-sm text-muted">{profile.handle}</p>

      {badges.topSeller || badges.level !== "none" || level ? (
        <div className="flex flex-wrap justify-center gap-1.5">
          {level ? <LevelBadge badge={level} /> : null}
          {badges.topSeller ? <Badge tone="warning">{tp("badgeTopSeller")}</Badge> : null}
          {badges.level !== "none" ? (
            <Badge tone="brand">{tp("badgeCreatorLevel", { level: tp(LEVEL_KEYS[badges.level]) })}</Badge>
          ) : null}
        </div>
      ) : null}

      {profile.bio ? <p className="max-w-sm whitespace-pre-line text-sm leading-5 text-fg">{profile.bio}</p> : null}

      {profile.links.length > 0 ? (
        <ul className="flex flex-wrap justify-center gap-2">
          {profile.links.map((link) => (
            <li key={link.url}>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                className="inline-flex min-h-9 items-center gap-1 rounded-full border border-subtle bg-surface px-3 text-xs font-semibold text-fg hover:bg-surface-2"
              >
                <Link2 aria-hidden className="h-3.5 w-3.5" />
                {link.label === "website" ? t("website") : link.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {profile.categories.length > 0 ? (
        <ul className="flex flex-wrap justify-center gap-1.5">
          {profile.categories.map((cat) => (
            <li key={cat}>
              <Badge tone="neutral">#{cat}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
