"use client";

import Link from "next/link";
import { CheckCircle2, Clapperboard, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import type { FeedSource } from "@/lib/feed/types";

export function FeedLoading() {
  const t = useTranslations("explore");
  return (
    <div className="relative h-full w-full bg-canvas" role="status" aria-label={t("loadingAria")}>
      <Skeleton className="absolute inset-0 rounded-none" />
      <div className="absolute bottom-24 left-4 right-20 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

export function FeedError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("explore");
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <ErrorState title={t("feedErrorTitle")} description={t("feedErrorDescription")} onRetry={onRetry} />
    </div>
  );
}

export function FeedEmpty({ source, onForYou }: { source: FeedSource; onForYou: () => void }) {
  const t = useTranslations("explore");
  if (source === "following") {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <EmptyState
          icon={Users}
          title={t("followingEmptyTitle")}
          description={t("followingEmptyDescription")}
          action={<Button onClick={onForYou}>{t("forYouTab")}</Button>}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <EmptyState
        icon={Clapperboard}
        title={t("nuExistaVideoclipuri")}
        description={t("fiiPrimulCareAdauga")}
        action={
          <Button asChild>
            <Link href="/upload">{t("createClip")}</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Ultimul slide: nu mai sunt clipuri noi → spre Discover. */
export function FeedEnd() {
  const t = useTranslations("explore");
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <EmptyState
        icon={CheckCircle2}
        title={t("caughtUpTitle")}
        description={t("caughtUpDescription")}
        action={
          <Button asChild variant="secondary">
            <Link href="/discover">{t("exploreModules")}</Link>
          </Button>
        }
      />
    </div>
  );
}
