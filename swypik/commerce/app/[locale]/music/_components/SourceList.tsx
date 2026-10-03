"use client";
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Radio } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import TrackRow from "@/components/music/TrackRow";
import { audioItemToTrackDto } from "@/lib/audio/types";
import { useAudioFeed, type AudioTabId } from "../_lib/useAudioFeed";

const SUBTITLE_KEY: Partial<Record<AudioTabId, string>> = {
  radio: "audio.radioStationsSubtitle",
  audius: "audio.subtitleAudius",
  jamendo: "audio.subtitleJamendo",
  podcast: "audio.subtitlePodcast",
};

/** Un tab de sursă externă ca listă de rânduri; stări: încărcare, eroare, neconfigurat, gol. */
export default function SourceList({ tab, title }: { tab: Exclude<AudioTabId, "all">; title: string }) {
  const t = useTranslations("music");
  const { sections, unconfigured, failed, retry } = useAudioFeed(tab);
  const tracks = useMemo(() => (sections ?? []).flatMap((s) => s.items.map(audioItemToTrackDto)), [sections]);
  const subtitleKey = SUBTITLE_KEY[tab];

  return (
    <section className="mx-auto max-w-3xl pt-3">
      <div className="px-gutter pb-2">
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        {subtitleKey && <p className="text-xs text-muted">{t(subtitleKey)}</p>}
      </div>
      {unconfigured.includes(tab) ? (
        <EmptyState icon={Radio} title={t("audio.sourceNotConfigured")} description={t("audio.sourceNotConfiguredBody")} />
      ) : sections === null ? (
        <SkeletonText lines={6} className="px-gutter" />
      ) : failed ? (
        <ErrorState title={t("audio.sourceUnavailable")} onRetry={retry} />
      ) : tracks.length === 0 ? (
        <EmptyState icon={Radio} title={t("audio.noResults")} />
      ) : (
        <div>{tracks.map((tr, i) => <TrackRow key={tr.id} track={tr} queue={tracks} index={i} />)}</div>
      )}
    </section>
  );
}
