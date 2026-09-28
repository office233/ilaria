/**
 * Generarea candidaților: toate sursele în paralel; o sursă care cade (ex. MV
 * lipsă înainte de migrare) e logată și ignorată, nu doboară feed-ul.
 */
import { logger } from "@/lib/logger";
import type { CandidateSource } from "../scoring";
import { backfillCandidates } from "./backfill";
import type { CandidateContext, CandidateHit } from "./common";
import { embeddingCandidates } from "./embedding";
import { exploreCandidates } from "./explore";
import { followingCandidates } from "./following";
import { freshCandidates } from "./fresh";
import { topicCandidates } from "./topic";
import { trendingCandidates } from "./trending";

export type { CandidateContext, CandidateHit } from "./common";

export type MergedCandidate = Omit<CandidateHit, "source" | "affinity"> & {
  sources: Set<CandidateSource>;
  affinity: number;
};

/** Pură: unește rezultatele surselor pe id (uniunea surselor, afinitatea maximă). */
export function mergeCandidateHits(lists: readonly (readonly CandidateHit[])[]): MergedCandidate[] {
  const byId = new Map<string, MergedCandidate>();
  for (const list of lists) {
    for (const hit of list) {
      const cur = byId.get(hit.id);
      if (cur) {
        cur.sources.add(hit.source);
        cur.affinity = Math.max(cur.affinity, hit.affinity ?? 0);
      } else {
        byId.set(hit.id, {
          id: hit.id,
          creatorId: hit.creatorId,
          publishedAt: hit.publishedAt,
          durationMs: hit.durationMs,
          sources: new Set([hit.source]),
          affinity: hit.affinity ?? 0,
        });
      }
    }
  }
  return Array.from(byId.values());
}

const SOURCES: ReadonlyArray<[CandidateSource, (ctx: CandidateContext) => Promise<CandidateHit[]>]> = [
  ["following", (ctx) => followingCandidates(ctx)],
  ["fresh", freshCandidates],
  ["trending", trendingCandidates],
  ["topic", topicCandidates],
  ["explore", exploreCandidates],
  ["embedding", embeddingCandidates],
  ["backfill", backfillCandidates],
];

export async function generateCandidates(ctx: CandidateContext): Promise<MergedCandidate[]> {
  const settled = await Promise.allSettled(SOURCES.map(([, fn]) => fn(ctx)));
  const lists: CandidateHit[][] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") lists.push(r.value);
    else logger.warn({ err: r.reason, source: SOURCES[i][0] }, "[feed/candidates] source failed");
  });
  return mergeCandidateHits(lists);
}
