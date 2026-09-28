import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { getEpisode, getSeriesBySlug } from "@/lib/movies/repository";
import PlayerClient from "./PlayerClient";

export const dynamic = "force-dynamic";

export default async function PlayerPage({ params }: { params: Promise<{ slug: string; n: string }> }) {
  if (!isEnabled("movies")) notFound();
  const { slug, n } = await params;
  const episodeNumber = Number(n);
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) notFound();
  // 404 real pentru serial/episod inexistent (nu 200 cu player gol).
  const series = await getSeriesBySlug(slug).catch(() => null);
  if (!series) notFound();
  const episode = await getEpisode(series.id, episodeNumber).catch(() => null);
  if (!episode) notFound();
  return <PlayerClient slug={slug} initialEpisode={episodeNumber} />;
}
