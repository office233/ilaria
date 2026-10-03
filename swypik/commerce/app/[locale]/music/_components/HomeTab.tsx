"use client";
import { useTranslations } from "next-intl";
import { ChevronRight, Music2 } from "lucide-react";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { audioItemToTrackDto, type AudioSourceType } from "@/lib/audio/types";
import { useCatalogRows, type AudioFeed, type AudioTabId } from "../_lib/useAudioFeed";
import MusicHomeRows, { Row } from "./MusicHomeRows";
import TrackCard from "./TrackCard";

function RowsSkeleton() {
  return (
    <div className="mt-6 flex gap-3 px-gutter" aria-hidden>
      {[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-square w-[38vw] max-w-[150px] rounded-card" />)}
    </div>
  );
}

/** Catalogul propriu e gol: o spunem onest, cu drumul spre artiști — fără rânduri false. */
function CatalogInPreparation() {
  const t = useTranslations("music");
  return (
    <div className="mx-gutter mt-4 flex items-start gap-3 rounded-card bg-surface-2 p-4">
      <Music2 className="mt-0.5 h-5 w-5 shrink-0 text-subtle" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">{t("catalogInPreparation")}</p>
        <p className="mt-0.5 text-sm text-muted">{t("catalogInPreparationBody")}</p>
        <Button asChild variant="link" className="mt-1 min-h-11">
          <Link href="/creator/music">{t("becomeArtist")}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Tab-ul „Toate": întâi catalogul Swypik, apoi sursele externe (doar secțiunile cu conținut). */
export default function HomeTab({ feed, onSeeAll }: { feed: AudioFeed; onSeeAll: (tab: AudioTabId) => void }) {
  const t = useTranslations("music");
  const catalog = useCatalogRows();
  const { sections, failed, retry } = feed;

  return (
    <div className="pb-6">
      {catalog === null ? <RowsSkeleton /> : catalog.length === 0 ? <CatalogInPreparation /> : <MusicHomeRows rows={catalog} />}

      {sections === null ? (
        <RowsSkeleton />
      ) : failed ? (
        <ErrorState title={t("audio.sourceUnavailable")} onRetry={retry} />
      ) : (
        sections.map((section) => {
          const tracks = section.items.map(audioItemToTrackDto);
          const source: AudioSourceType = section.source;
          return (
            <Row
              key={section.id}
              title={t(`audio.feedSections.${section.id}.title`)}
              subtitle={t(`audio.feedSections.${section.id}.subtitle`)}
              action={
                source !== "swypik" ? (
                  <Button variant="ghost" size="sm" className="min-h-11 shrink-0" onClick={() => onSeeAll(source)}>
                    {t("audio.seeAll")} <ChevronRight className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null
              }
            >
              {tracks.map((tr, i) => <TrackCard key={tr.id} track={tr} queue={tracks} index={i} />)}
            </Row>
          );
        })
      )}
    </div>
  );
}
