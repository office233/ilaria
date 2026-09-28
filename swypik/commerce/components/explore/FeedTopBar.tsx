"use client";

import Link from "next/link";
import { Search, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import AppMenuButton from "@/components/nav/AppMenuButton";
import { IconButton } from "@/components/ui/IconButton";
import type { FeedSource } from "@/lib/feed/types";
import { cn } from "@/lib/ui/cn";

type Props = {
  source: FeedSource;
  onSourceChange: (s: FeedSource) => void;
  /** Tab-urile For You / Following au sens doar în feed-ul general (nu profil/categorie). */
  showTabs: boolean;
  muted: boolean;
  onToggleMute: () => void;
};

const TABS: FeedSource[] = ["following", "foryou"];

/** Bara de sus: ☰ · Urmăriți / Pentru tine · căutare · sunet — un singur rând, nimic suprapus. */
export default function FeedTopBar({ source, onSourceChange, showTabs, muted, onToggleMute }: Props) {
  const t = useTranslations("explore");
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30 pt-safe-t">
      <div className="pointer-events-auto flex h-header items-center gap-1 px-2">
        <AppMenuButton variant="overlay" />
        <div className="flex flex-1 justify-center">
          {showTabs ? (
            <div role="tablist" aria-label={t("feedSourceAria")} className="flex items-center gap-1">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={source === tab}
                  onClick={() => onSourceChange(tab)}
                  className={cn(
                    "relative min-h-11 px-3 text-base font-semibold drop-shadow motion-safe:transition-colors",
                    source === tab ? "text-white after:absolute after:inset-x-3 after:bottom-1.5 after:h-0.5 after:rounded-full after:bg-white" : "text-white/60",
                  )}
                >
                  {tab === "foryou" ? t("forYouTab") : t("followingTab")}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <IconButton asChild variant="overlay" label={t("search")}>
          <Link href="/search">
            <Search aria-hidden />
          </Link>
        </IconButton>
        <IconButton variant="overlay" label={muted ? t("activeazaSunetul") : t("opresteSunetul")} aria-pressed={!muted} onClick={onToggleMute}>
          {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </IconButton>
      </div>
    </header>
  );
}
