import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { UserX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProfileHeader } from "@/components/social/profile/ProfileHeader";
import { ProfileMenu } from "@/components/social/profile/ProfileMenu";
import { ProfileSocialBar } from "@/components/social/profile/ProfileSocialBar";
import { ProfileTabs } from "@/components/social/profile/ProfileTabs";
import { PromotedProducts } from "@/components/social/profile/PromotedProducts";
import { getProfileLevelBadge } from "@/lib/gaming/level";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { Link, permanentRedirect } from "@/lib/i18n/navigation";
import { logger } from "@/lib/logger";
import { listSavedProducts } from "@/lib/shop/saved";
import { SOCIAL_PAGE } from "@/lib/social/config";
import { profilePath } from "@/lib/social/links";
import { localizedAlternates } from "@/lib/seo/hreflang";
import { canViewTab, listProfileVideos } from "@/lib/social/profile/videos";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { getPublicUserProfile, type PublicUserProfile } from "@/lib/social/user-profile";
import { resolveProfileParam } from "@/lib/social/username";

type Props = { params: Promise<{ locale: string; username: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, username } = await params;
  const t = await getTranslations({ locale, namespace: "userProfile" });
  try {
    const data = await getPublicUserProfile(username);
    if (!data) return { title: t("metaNotFoundTitle"), robots: { index: false, follow: false } };
    return {
      title: `${data.profile.displayName} (${data.profile.handle}) - Swypik`,
      description: data.profile.bio || t("metaDescriptionFallback", { name: data.profile.displayName }),
      alternates: localizedAlternates(locale, profilePath(data.profile.username)),
      openGraph: {
        title: `${data.profile.displayName} - Swypik`,
        description: data.profile.bio || t("metaOgDescriptionFallback"),
        type: "profile",
        images: data.profile.avatarUrl ? [data.profile.avatarUrl] : [],
      },
    };
  } catch {
    return { title: t("metaFallbackTitle") };
  }
}

async function loadTabs(data: PublicUserProfile, locale: string) {
  const { profile } = data;
  const likedVisible = canViewTab("liked", { isOwner: profile.isOwnProfile, likedVideosPublic: profile.likedVideosPublic });
  const page = { cursor: null, limit: SOCIAL_PAGE.videos };
  const [videos, saved] = await Promise.all([
    listProfileVideos("videos", profile.id, page),
    profile.isOwnProfile
      ? Promise.all([listProfileVideos("saved", profile.id, page), listSavedProducts(profile.id, locale, 60)]).then(
          ([v, products]) => ({ videos: v, products }),
        )
      : Promise.resolve(null),
  ]);
  return { likedVisible, videos, saved };
}

export default async function UserProfilePage({ params }: Props) {
  const { locale: rawLocale, username } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "social.profile" });

  // /u/<uuid> și /u/<username-vechi> → redirect permanent la username-ul curent.
  const route = await resolveProfileParam(username).catch(() => null);
  if (route?.kind === "not_found") notFound();
  if (route?.kind === "redirect") permanentRedirect({ href: profilePath(route.username), locale });

  let data: PublicUserProfile | null = null;
  let tabs: Awaited<ReturnType<typeof loadTabs>> | null = null;
  try {
    const viewerUserId = await getOptionalSocialUserId().catch(() => null);
    data = await getPublicUserProfile(route?.username ?? username, { viewerUserId });
    if (data && !data.profile.blocksViewer && !data.profile.blockedByViewer) tabs = await loadTabs(data, locale);
  } catch (error) {
    logger.error({ err: error }, "[User Profile Page] load failed");
    return (
      <div className="min-h-dvh bg-canvas">
        <PageHeader back="/explore" title={t("title")} />
        <ErrorState className="py-16" />
      </div>
    );
  }
  if (!data) notFound();

  const { profile, stats, badges, promotedProducts } = data;
  const restricted = profile.blocksViewer || profile.blockedByViewer;
  const level = restricted ? null : await getProfileLevelBadge(profile.id);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        back="/explore"
        title={profile.username}
        actions={
          <ProfileMenu
            userId={profile.id}
            username={profile.username}
            displayName={profile.displayName}
            isOwnProfile={profile.isOwnProfile}
            blockedByViewer={profile.blockedByViewer}
          />
        }
      />
      <main className="mx-auto flex max-w-md flex-col gap-6 pb-6 pt-4">
        <div className="flex flex-col items-center gap-4 px-gutter">
          <ProfileHeader locale={locale} profile={profile} badges={badges} level={level} />
          <ProfileSocialBar
            userId={profile.id}
            username={profile.username}
            displayName={profile.displayName}
            isOwnProfile={profile.isOwnProfile}
            initialFollowing={profile.isFollowing}
            stats={stats}
            restricted={restricted}
          />
        </div>

        {restricted ? (
          <EmptyState
            icon={UserX}
            title={profile.blockedByViewer ? t("youBlockedTitle") : t("unavailableTitle")}
            description={profile.blockedByViewer ? t("youBlockedBody") : t("unavailableBody")}
            action={
              <Button asChild variant="secondary">
                <Link href="/explore">{t("backToFeed")}</Link>
              </Button>
            }
          />
        ) : (
          <>
            <PromotedProducts locale={locale} products={promotedProducts} />
            {tabs ? (
              <ProfileTabs
                username={profile.username}
                displayName={profile.displayName}
                isOwnProfile={profile.isOwnProfile}
                likedVisible={tabs.likedVisible}
                likedVideosPublic={profile.likedVideosPublic}
                videos={tabs.videos}
                saved={tabs.saved}
              />
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
