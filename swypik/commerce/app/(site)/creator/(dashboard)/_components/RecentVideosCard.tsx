/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Film } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { RecentVideo } from "../_data";
import { VideoStatusBadge, deriveVideoStatus } from "./VideoStatusBadge";

export function RecentVideosCard({ videos }: { videos: RecentVideo[] }) {
  const t = useTranslations("creatorStudio.overview");
  const format = useFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("recentVideos")}</CardTitle>
        <Link href="/creator/videos" className="flex min-h-11 items-center text-sm font-semibold text-brand hover:underline">
          {t("seeAll")}
        </Link>
      </CardHeader>
      {videos.length === 0 ? (
        <EmptyState
          icon={Film}
          title={t("noVideosTitle")}
          description={t("noVideosBody")}
          action={
            <Button asChild>
              <Link href="/upload">{t("uploadFirst")}</Link>
            </Button>
          }
          className="py-6"
        />
      ) : (
        <ul className="-mx-2 divide-y divide-subtle">
          {videos.map((v) => (
            <li key={v.id}>
              <Link
                href="/creator/videos"
                className="flex min-h-14 items-center gap-3 rounded-control px-2 py-2 transition-colors duration-fast hover:bg-surface-2"
              >
                {v.thumbnailUrl ? (
                  <img src={v.thumbnailUrl} alt="" className="h-14 w-10 shrink-0 rounded-control bg-surface-2 object-cover" />
                ) : (
                  <span className="flex h-14 w-10 shrink-0 items-center justify-center rounded-control bg-surface-2 text-subtle">
                    <Film className="h-4 w-4" aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-fg">{v.title || t("untitled")}</span>
                  <span className="block truncate text-xs text-muted">
                    {t("videoMeta", {
                      views: format.number(v.viewCount),
                      date: format.dateTime(new Date(v.createdAt), { dateStyle: "medium" }),
                    })}
                  </span>
                </span>
                <VideoStatusBadge
                  status={deriveVideoStatus({
                    status: v.status,
                    visibility: v.visibility,
                    isDraft: v.isDraft,
                    scheduledPublishAt: v.scheduledPublishAt,
                  })}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
