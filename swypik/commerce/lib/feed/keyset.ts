/**
 * Moduri cronologice (fără ranking, fără carduri): Following, categorie,
 * profil de creator. Paginare keyset pe (published_at, id) — fără OFFSET.
 */
import { dbQuery } from "@/lib/db";
import type { Keyset } from "./cursor";
import { LINKED_PRODUCT_ID_SQL, notHiddenByViewerSql, productAttachSql, visibleVideoSql } from "./visibility";

export type KeysetFilter =
  | { kind: "creator"; creatorId: string }
  | { kind: "following"; creatorIds: readonly string[] }
  | { kind: "category"; slug: string };

export type KeysetPage = { ids: string[]; next: Keyset | null };

type Row = { id: string; published_key: string };

export async function keysetPage(
  filter: KeysetFilter,
  after: Keyset | null,
  limit: number,
  userId: string | null,
): Promise<KeysetPage> {
  if (filter.kind === "following" && filter.creatorIds.length === 0) return { ids: [], next: null };
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (filter.kind === "creator") where.push(`AND v.creator_id = ${bind(filter.creatorId)}::uuid`);
  if (filter.kind === "following") where.push(`AND v.creator_id = ANY(${bind(filter.creatorIds)}::uuid[])`);
  if (filter.kind === "category") {
    where.push(`AND EXISTS (
      SELECT 1 FROM marketplace_products p
       WHERE p.id = ${LINKED_PRODUCT_ID_SQL}
         AND ${productAttachSql({ softBlock: false })}
         AND p.taxonomy_node_slug IN (
           WITH RECURSIVE d AS (
             SELECT slug FROM taxonomy_nodes WHERE slug = ${bind(filter.slug)}::text
             UNION ALL SELECT n.slug FROM taxonomy_nodes n JOIN d ON n.parent_slug = d.slug
           ) SELECT slug FROM d))`);
  }
  if (after) {
    where.push(`AND (COALESCE(v.published_at, v.created_at), v.id) < (${bind(after.t)}::timestamptz, ${bind(after.id)}::uuid)`);
  }
  const userP = userId ? bind(userId) : null;
  const limitP = bind(limit + 1);
  const { rows } = await dbQuery<Row>(
    // Cheia cu microsecunde (Date din JS are doar ms → duplicate la paginare).
    `SELECT v.id::text AS id,
            to_char(COALESCE(v.published_at, v.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_key
       FROM videos v
      WHERE ${visibleVideoSql()}
        ${notHiddenByViewerSql(userP)}
        ${where.join("\n        ")}
      ORDER BY COALESCE(v.published_at, v.created_at) DESC, v.id DESC
      LIMIT ${limitP}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? { t: String(last.published_key), id: String(last.id) } : null;
  return { ids: page.map((r) => String(r.id)), next };
}
