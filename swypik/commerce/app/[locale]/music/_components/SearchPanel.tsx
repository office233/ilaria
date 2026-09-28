"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonText } from "@/components/ui/Skeleton";
import TrackRow from "@/components/music/TrackRow";
import { audioItemToTrackDto, type AudioItemDto } from "@/lib/audio/types";
import type { TrackDto } from "@/lib/music/types";
import { mergeSearchResults } from "@/lib/music/search";

const SEARCH_DEBOUNCE_MS = 300;

/** Rezultatele căutării audio (catalogul Swypik + surse externe), cu debounce. */
export default function SearchPanel({ query }: { query: string }) {
  const t = useTranslations("music");
  const [results, setResults] = useState<TrackDto[] | null>(null);

  useEffect(() => {
    const q = query.trim();
    setResults(null);
    if (!q) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const opts = { signal: ctrl.signal };
      // Catalogul propriu Swypik primul, apoi sursele externe; o sursă căzută nu golește lista.
      const own = fetch(`/api/music/tracks?q=${encodeURIComponent(q)}`, opts)
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d: { items?: TrackDto[] }) => d.items ?? [])
        .catch(() => [] as TrackDto[]);
      const external = fetch(`/api/audio/search?q=${encodeURIComponent(q)}`, opts)
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d: { items?: AudioItemDto[] }) => (d.items ?? []).map(audioItemToTrackDto))
        .catch(() => [] as TrackDto[]);
      void Promise.all([own, external]).then(([mine, ext]) => {
        if (!ctrl.signal.aborted) setResults(mergeSearchResults(mine, ext));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [query]);

  return (
    <section className="mx-auto max-w-3xl pt-3" aria-live="polite">
      <h2 className="px-gutter pb-2 text-sm font-semibold text-muted">{t("audio.searchResults")}</h2>
      {results === null ? (
        <SkeletonText lines={5} className="px-gutter" />
      ) : results.length === 0 ? (
        <EmptyState icon={Search} title={t("audio.noResults")} />
      ) : (
        <div>{results.map((tr, i) => <TrackRow key={tr.id} track={tr} queue={results} index={i} />)}</div>
      )}
    </section>
  );
}
