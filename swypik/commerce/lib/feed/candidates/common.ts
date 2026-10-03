/**
 * Etapa 1 din ranker-ul în două etape: surse ieftine de candidați (câteva sute
 * de id-uri), fiecare într-un fișier. Fiecare sursă aplică regulile de
 * vizibilitate și exclude clipurile deja servite viewerului (seen-set Redis).
 */
import { dbQuery } from "@/lib/db";
import type { RankConfig } from "../config";
import type { CandidateSource } from "../scoring";
import { notHiddenByViewerSql, visibleVideoSql } from "../visibility";

export type CandidateContext = {
  userId: string | null;
  /** Clipuri de exclus (seen-set + deja în pagină). */
  exclude: readonly string[];
  followedCreatorIds: readonly string[];
  cfg: RankConfig;
};

export type CandidateHit = {
  id: string;
  creatorId: string | null;
  publishedAt: Date;
  durationMs: number | null;
  source: CandidateSource;
  /** Doar sursa topic: 0..1. */
  affinity?: number;
};

type Row = {
  id: string;
  creator_id: string | null;
  published_at: string | Date;
  duration_ms: number | string | null;
  affinity?: number | string | null;
};

/** Leagă o valoare ca parametru și întoarce placeholder-ul ($n). */
export type Bind = (value: unknown) => string;

export type CandidateQuery = {
  with?: string;
  from?: string;
  select?: string;
  extraWhere?: string;
  orderBy: string;
  limit: number;
};

export const CANDIDATE_COLUMNS = `v.id::text AS id, v.creator_id::text AS creator_id,
  COALESCE(v.published_at, v.created_at) AS published_at, v.duration_ms`;

/**
 * Rulează o interogare de candidați. Fragmentele SQL ale sursei nu conțin input
 * utilizator; valorile trec prin `bind` (parametri pg).
 */
export async function runCandidateQuery(
  ctx: CandidateContext,
  source: CandidateSource,
  build: (bind: Bind, userParam: string | null) => CandidateQuery,
): Promise<CandidateHit[]> {
  const params: unknown[] = [];
  const bind: Bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const excludeP = bind(ctx.exclude);
  const userP = ctx.userId ? bind(ctx.userId) : null;
  const q = build(bind, userP);
  const limit = Math.max(0, Math.trunc(q.limit));
  if (limit === 0) return [];
  const limitP = bind(limit);
  const { rows } = await dbQuery<Row>(
    `${q.with ?? ""}
     SELECT ${CANDIDATE_COLUMNS}${q.select ? `, ${q.select}` : ""}
       FROM ${q.from ?? "videos v"}
      WHERE ${visibleVideoSql()}
        AND NOT (v.id = ANY(${excludeP}::uuid[]))
        ${notHiddenByViewerSql(userP)}
        ${q.extraWhere ?? ""}
      ORDER BY ${q.orderBy}
      LIMIT ${limitP}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    creatorId: r.creator_id ? String(r.creator_id) : null,
    publishedAt: new Date(r.published_at),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    source,
    ...(r.affinity != null ? { affinity: Number(r.affinity) } : {}),
  }));
}
