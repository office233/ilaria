"use client";
import { useTranslations } from "next-intl";
import { trackAttribution } from "@/lib/audio/attribution";
import { cn } from "@/lib/ui/cn";
import type { TrackDto } from "@/lib/music/types";

/** Linia de atribuire CC BY / BY-SA pentru piesele externe (Jamendo): licență + sursă, cu linkuri. */
export default function TrackAttribution({ track, className }: { track: TrackDto; className?: string }) {
  const t = useTranslations("music");
  const a = trackAttribution(track);
  if (!a) return null;
  return (
    <p className={cn("truncate text-xs text-subtle", className)}>
      {t.rich("attribution", {
        title: track.title,
        artist: track.artist.stageName,
        license: a.licenseName,
        source: a.sourceName,
        licenseLink: (chunks) => (
          <a href={a.licenseUrl} target="_blank" rel="noopener noreferrer license" className="underline hover:text-fg">{chunks}</a>
        ),
        sourceLink: (chunks) =>
          a.sourceUrl ? (
            <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg">{chunks}</a>
          ) : (
            <>{chunks}</>
          ),
      })}
    </p>
  );
}
