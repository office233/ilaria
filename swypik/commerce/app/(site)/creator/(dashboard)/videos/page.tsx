"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Film, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StudioHeading } from "../_components/StudioHeading";
import { deriveVideoStatus } from "../_components/VideoStatusBadge";
import { VideoCard, type CreatorVideo } from "./_components/VideoCard";

const POLL_MS = 10_000;

function VideosSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i} padding="none" className="overflow-hidden">
          <Skeleton className="aspect-[9/16] max-h-72 w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function CreatorVideosPage() {
  const t = useTranslations("creatorStudio.videos");
  const [videos, setVideos] = useState<CreatorVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchVideos(initial: boolean) {
      try {
        const res = await fetch("/api/creator/videos", { cache: "no-store" });
        if (!res.ok) throw new Error(`status_${res.status}`);
        const data = (await res.json()) as { videos?: CreatorVideo[] };
        if (cancelled) return;
        const list = data.videos ?? [];
        setVideos(list);
        setFailed(false);
        // Re-verificăm cât timp un clip încă se procesează.
        if (list.some((v) => v.status === "processing" || v.status === "uploading")) {
          timer = setTimeout(() => fetchVideos(false), POLL_MS);
        }
      } catch {
        if (!cancelled && initial) setFailed(true);
      } finally {
        if (initial && !cancelled) setLoading(false);
      }
    }

    setLoading(true);
    void fetchVideos(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const statuses = videos.map((v) => deriveVideoStatus({ status: v.status, visibility: v.visibility }));
  const readyCount = statuses.filter((s) => s === "ready").length;
  const processingCount = statuses.filter((s) => s === "processing").length;

  return (
    <div>
      <StudioHeading
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button asChild size="sm">
            <Link href="/upload">
              <Upload className="h-4 w-4" aria-hidden />
              {t("uploadNew")}
            </Link>
          </Button>
        }
      />

      {loading ? (
        <VideosSkeleton />
      ) : failed ? (
        <Card>
          <ErrorState title={t("loadErrorTitle")} description={t("loadErrorBody")} onRetry={retry} />
        </Card>
      ) : videos.length === 0 ? (
        <Card>
          <EmptyState
            icon={Film}
            title={t("emptyTitle")}
            description={t("emptyBody")}
            action={
              <Button asChild>
                <Link href="/upload">{t("goUpload")}</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            {t("summary", { total: videos.length, ready: readyCount })}
            {processingCount > 0 ? ` · ${t("summaryProcessing", { count: processingCount })}` : ""}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {videos.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
