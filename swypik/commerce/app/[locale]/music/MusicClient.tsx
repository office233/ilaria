"use client";

/**
 * Swypik Music — acasă: catalogul propriu întâi, apoi surse externe legale
 * (radio live https, Audius, Jamendo doar cu cheie, podcasturi). Imersiv
 * (dark), mobil întâi, doar primitive și tokeni.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { PageHeader } from "@/components/ui/PageHeader";
import { Input } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";
import MusicBrand from "@/components/music/MusicBrand";
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";
import LockedOverlay from "./_components/LockedOverlay";
import SourceTabs from "./_components/SourceTabs";
import SearchPanel from "./_components/SearchPanel";
import SourceList from "./_components/SourceList";
import HomeTab from "./_components/HomeTab";
import { useAudioFeed, type AudioTabId } from "./_lib/useAudioFeed";

const TAB_LABEL_KEY: Record<Exclude<AudioTabId, "all">, string> = {
  radio: "audio.radioStationsTitle",
  audius: "audio.tabs.audius",
  jamendo: "audio.tabs.jamendo",
  podcast: "audio.tabs.podcast",
};

export default function MusicClient() {
  const t = useTranslations("music");
  const { current } = useMusicPlayer();
  const [tab, setTab] = useState<AudioTabId>("all");
  const [query, setQuery] = useState("");
  // Feed-ul „Toate" se încarcă o singură dată; ascunde și filtrele surselor neconfigurate.
  const feed = useAudioFeed("all");
  const searching = query.trim().length > 0;

  return (
    <ImmersiveSurface>
      <PageHeader title={<MusicBrand />}>
        <div className="px-gutter pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("audio.searchPlaceholder")}
              aria-label={t("audio.searchPlaceholder")}
              className="pl-9 pr-11"
            />
            {query && (
              <IconButton size="sm" label={t("audio.clearSearch")} onClick={() => setQuery("")} className="absolute right-1 top-1/2 -translate-y-1/2">
                <X aria-hidden />
              </IconButton>
            )}
          </div>
        </div>
        {!searching && <SourceTabs active={tab} onChange={setTab} unconfigured={feed.unconfigured} />}
      </PageHeader>

      {searching ? (
        <SearchPanel query={query} />
      ) : tab === "all" ? (
        <HomeTab feed={feed} onSeeAll={setTab} />
      ) : (
        <SourceList key={tab} tab={tab} title={t(TAB_LABEL_KEY[tab])} />
      )}

      {/* Spațiu pentru mini-player (BottomNav e deja rezervat de #main-content). */}
      {current && <div className="h-20" aria-hidden />}
      <LockedOverlay />
    </ImmersiveSurface>
  );
}
