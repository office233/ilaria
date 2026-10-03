"use client";

import { Bookmark, Grid3x3, Heart, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { ProductCard } from "@/components/shop/ProductCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import type { ProfileVideoPage } from "@/lib/social/profile/videos";
import type { SavedProduct } from "@/lib/shop/saved";
import { LikedPrivacySwitch } from "./LikedPrivacySwitch";
import { VideoGrid } from "./VideoGrid";

export type ProfileTabsProps = {
  username: string;
  displayName: string;
  isOwnProfile: boolean;
  likedVisible: boolean;
  likedVideosPublic: boolean;
  videos: ProfileVideoPage;
  /** Prima pagină „Salvate" — doar pe profilul propriu. */
  saved: { videos: ProfileVideoPage; products: SavedProduct[] } | null;
};

/** Tab-urile profilului: Clipuri · Apreciate (după setarea de confidențialitate) · Salvate (doar propriu). */
export function ProfileTabs({
  username,
  displayName,
  isOwnProfile,
  likedVisible,
  likedVideosPublic,
  videos,
  saved,
}: ProfileTabsProps) {
  const t = useTranslations("social.profile");

  return (
    <Tabs defaultValue="videos" className="w-full">
      <TabsList className="justify-center">
        <TabsTrigger value="videos" aria-label={t("tabVideos")} className="flex-1 gap-1.5">
          <Grid3x3 aria-hidden className="h-4 w-4" />
          {t("tabVideos")}
        </TabsTrigger>
        <TabsTrigger value="liked" aria-label={t("tabLiked")} className="flex-1 gap-1.5">
          {likedVisible ? <Heart aria-hidden className="h-4 w-4" /> : <Lock aria-hidden className="h-4 w-4" />}
          {t("tabLiked")}
        </TabsTrigger>
        {saved ? (
          <TabsTrigger value="saved" aria-label={t("tabSaved")} className="flex-1 gap-1.5">
            <Bookmark aria-hidden className="h-4 w-4" />
            {t("tabSaved")}
          </TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="videos" className="pt-0.5">
        <VideoGrid
          username={username}
          tab="videos"
          initial={videos}
          emptyTitle={isOwnProfile ? t("emptyOwnVideos") : t("emptyVideos")}
          emptyDescription={isOwnProfile ? undefined : t("emptyVideosBody", { name: displayName })}
        />
      </TabsContent>

      <TabsContent value="liked" className="pt-0.5">
        {isOwnProfile ? <LikedPrivacySwitch initial={likedVideosPublic} /> : null}
        {likedVisible ? (
          <VideoGrid username={username} tab="liked" initial={null} emptyTitle={t("emptyLiked")} />
        ) : (
          <EmptyState icon={Lock} title={t("likedPrivateTitle")} description={t("likedPrivateBody", { name: displayName })} className="py-12" />
        )}
      </TabsContent>

      {saved ? (
        <TabsContent value="saved" className="flex flex-col gap-6 pt-0.5">
          <VideoGrid username={username} tab="saved" initial={saved.videos} emptyTitle={t("emptySavedVideos")} />
          <section className="px-gutter">
            <h2 className="mb-3 text-base font-semibold text-fg">{t("savedProducts")}</h2>
            {saved.products.length === 0 ? (
              <p className="text-sm text-muted">{t("emptySavedProducts")}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {saved.products.map((p) => (
                  <li key={p.id}>
                    <ProductCard product={p} className={p.available ? undefined : "opacity-60"} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
