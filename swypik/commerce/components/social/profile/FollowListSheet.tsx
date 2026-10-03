"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Link } from "@/lib/i18n/navigation";
import { profilePath } from "@/lib/social/links";
import type { FollowListItem } from "@/lib/social/follows";
import FollowButton from "../FollowButton";

export type FollowDirection = "followers" | "following";

type ListState = { items: FollowListItem[]; cursor: string | null; status: "loading" | "ready" | "error"; loadingMore: boolean };

const EMPTY: ListState = { items: [], cursor: null, status: "loading", loadingMore: false };

function FollowList({ userId, direction, active }: { userId: string; direction: FollowDirection; active: boolean }) {
  const t = useTranslations("social.profile");
  const [s, setS] = useState<ListState>(EMPTY);

  const load = useCallback(
    async (cursor: string | null) => {
      setS((p) => (cursor ? { ...p, loadingMore: true } : { ...EMPTY }));
      try {
        const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const res = await fetch(`/api/users/${encodeURIComponent(userId)}/${direction}${qs}`, { credentials: "include" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { items: FollowListItem[]; nextCursor: string | null };
        setS((p) => ({
          items: cursor ? [...p.items, ...data.items] : data.items,
          cursor: data.nextCursor,
          status: "ready",
          loadingMore: false,
        }));
      } catch {
        setS((p) => (cursor ? { ...p, loadingMore: false } : { ...p, status: "error" }));
      }
    },
    [direction, userId],
  );

  useEffect(() => {
    if (active) void load(null);
  }, [active, load]);

  if (s.status === "loading") {
    return (
      <div className="flex flex-col gap-3 py-2" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    );
  }
  if (s.status === "error") return <ErrorState onRetry={() => void load(null)} />;
  if (s.items.length === 0) {
    return <EmptyState icon={Users} title={direction === "followers" ? t("noFollowers") : t("noFollowing")} />;
  }

  return (
    <>
      <ul className="flex flex-col">
        {s.items.map((u) => (
          <li key={u.id} className="flex min-h-14 items-center gap-3 py-1">
            <Link href={profilePath(u.username)} className="flex min-w-0 flex-1 items-center gap-3">
              <Avatar src={u.avatarUrl} name={u.displayName} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-fg">{u.displayName}</span>
                <span className="block truncate text-xs text-muted">@{u.username}</span>
              </span>
            </Link>
            {u.isViewer ? null : <FollowButton userId={u.id} initialFollowing={u.viewerFollows} size="sm" />}
          </li>
        ))}
      </ul>
      {s.cursor ? (
        <div className="flex justify-center py-3">
          <Button variant="ghost" size="sm" loading={s.loadingMore} onClick={() => void load(s.cursor)}>
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export type FollowListSheetProps = {
  userId: string;
  username: string;
  open: FollowDirection | null;
  onOpenChange: (open: FollowDirection | null) => void;
};

/** Urmăritori / Urmăriți într-un bottom sheet cu tab-uri și paginare prin cursor. */
export function FollowListSheet({ userId, username, open, onOpenChange }: FollowListSheetProps) {
  const t = useTranslations("social.profile");
  return (
    <Sheet open={open !== null} onOpenChange={(o) => !o && onOpenChange(null)} title={`@${username}`} className="max-h-[85dvh]">
      {open ? (
        <Tabs value={open} onValueChange={(v) => onOpenChange(v as FollowDirection)}>
          <TabsList className="mb-2">
            <TabsTrigger value="followers">{t("followers")}</TabsTrigger>
            <TabsTrigger value="following">{t("following")}</TabsTrigger>
          </TabsList>
          <TabsContent value="followers">
            <FollowList userId={userId} direction="followers" active={open === "followers"} />
          </TabsContent>
          <TabsContent value="following">
            <FollowList userId={userId} direction="following" active={open === "following"} />
          </TabsContent>
        </Tabs>
      ) : null}
    </Sheet>
  );
}
