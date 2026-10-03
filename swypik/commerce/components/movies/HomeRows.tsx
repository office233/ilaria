"use client";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import PosterCard from "./PosterCard";
import { genreLabelKey } from "@/lib/movies/genres";
import type { HomeRow } from "@/lib/movies/home";

export function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 px-gutter text-base font-semibold text-fg">{title}</h2>
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-gutter pb-2 [scrollbar-width:none]">{children}</div>
    </section>
  );
}

/** Rândurile paginii /movies; rândurile goale nu ajung aici (vezi lib/movies/home.ts). */
export default function HomeRows({ rows }: { rows: HomeRow[] }) {
  const t = useTranslations("movies");
  return (
    <>
      {rows.map((row) => {
        switch (row.kind) {
          case "continue":
            return (
              <Row key="continue" title={t("continueWatching")}>
                {row.items.map((c) => (
                  <PosterCard
                    key={c.series.id}
                    series={c.series}
                    href={`/movies/${c.series.slug}/${c.episodeNumber}`}
                    progressPct={c.durationMs ? Math.round((c.positionMs / c.durationMs) * 100) : 0}
                  />
                ))}
              </Row>
            );
          case "mylist":
            return <Row key="mylist" title={t("myList")}>{row.items.map((s) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} />)}</Row>;
          case "top10":
            return <Row key="top10" title={t("top10Today")}>{row.items.map((s, i) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} rank={i + 1} />)}</Row>;
          case "originals":
            return <Row key="originals" title={t("originals")}>{row.items.map((s) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} />)}</Row>;
          case "latest":
            return <Row key="latest" title={t("newReleases")}>{row.items.map((s) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} />)}</Row>;
          case "genre":
            return (
              <Row key={`genre-${row.genre}`} title={t(genreLabelKey(row.genre))}>
                {row.items.map((s) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} />)}
              </Row>
            );
        }
      })}
    </>
  );
}
