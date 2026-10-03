"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Film, Play } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Link } from "@/lib/i18n/navigation";
import { formatCount } from "@/lib/social/format";
import { videoPath } from "@/lib/social/links";
import type { ProfileTab, ProfileVideo, ProfileVideoPage } from "@/lib/social/profile/videos";

export type VideoGridProps = {
  username: string;
  tab: ProfileTab;
  initial: ProfileVideoPage | null;
  emptyTitle: string;
  emptyDescription?: string;
};

/** Grila 3 coloane (9:16) cu încărcare la derulare prin cursor + stări de gol/eroare. */
export function VideoGrid({ username, tab, initial, emptyTitle, emptyDescription }: VideoGridProps) {
  const t = useTranslations("social.profile");
  const locale = useLocale();
  const [items, setItems] = useState<ProfileVideo[]>(initial?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(initial?.nextCursor ?? null);
  const [state, setState] = useState<"idle" | "loading" | "error">(initial ? "idle" : "loading");
  const sentinel = useRef<HTMLDivElement>(null);
  const loaded = useRef(Boolean(initial));

  const fetchPage = useCallback(
    async (after: string | null) => {
      setState("loading");
      try {
        const qs = new URLSearchParams({ tab });
        if (after) qs.set("cursor", after);
        const res = await fetch(`/api/users/profile/${encodeURIComponent(username)}/videos?${qs}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const page = (await res.json()) as ProfileVideoPage;
        setItems((prev) => {
          const seen = new Set(prev.map((v) => v.id));
          return [...(after ? prev : []), ...page.items.filter((v) => !after || !seen.has(v.id))];
        });
        setCursor(page.nextCursor);
        setState("idle");
      } catch {
        setState("error");
      }
    },
    [tab, username],
  );

  // Tab-urile fără date inițiale (ex. „Apreciate" deschis prima oară) se încarcă la montare.
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void fetchPage(null);
  }, [fetchPage]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor || state !== "idle") return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void fetchPage(cursor), { rootMargin: "400px" });
    io.observe(node);
    return () => io.disconnect();
  }, [cursor, fetchPage, state]);

  if (items.length === 0 && state === "loading") {
    return (
      <div className="grid grid-cols-3 gap-0.5" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] rounded-none" />
        ))}
      </div>
    );
  }
  if (items.length === 0 && state !== "error") {
    return <EmptyState icon={Film} title={emptyTitle} description={emptyDescription} className="py-12" />;
  }

  return (
    <>
      <ul className="grid grid-cols-3 gap-0.5">
        {items.map((video) => (
          <li key={video.id}>
            <Link href={videoPath(video.id)} className="group relative block aspect-[9/16] overflow-hidden bg-surface-2">
              {video.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- miniaturi din storage extern
                <img src={video.thumbnailUrl} alt={video.title ?? t("clipAlt")} loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full w-full place-items-center text-subtle">
                  <Film aria-hidden className="h-7 w-7" />
                </span>
              )}
              <span className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/70 to-transparent" />
              <span className="absolute bottom-1 left-1.5 inline-flex items-center gap-1 text-xs font-semibold text-white">
                <Play aria-hidden className="h-3 w-3" fill="currentColor" />
                {formatCount(video.viewCount, locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {state === "error" ? (
        <div className="flex flex-col items-center gap-2 py-6 text-sm text-muted">
          <p>{t("loadError")}</p>
          <Button variant="secondary" size="sm" onClick={() => void fetchPage(items.length ? cursor : null)}>
            {t("retry")}
          </Button>
        </div>
      ) : cursor ? (
        <div ref={sentinel} className="flex justify-center py-6">
          {state === "loading" ? <Skeleton className="h-4 w-24" /> : null}
        </div>
      ) : null}
    </>
  );
}
