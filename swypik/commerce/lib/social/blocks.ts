/**
 * Blocare utilizatori (tabela `user_blocks`, migrarea 20260926_0112).
 *
 * O blocare e reciprocă ca efect: niciunul nu îl mai poate urmări, menționa
 * sau notifica pe celălalt, iar comentariile lor sunt ascunse unul altuia.
 * La blocare se șterg follow-urile în ambele sensuri.
 */
import { dbQuery, withTransaction } from "@/lib/db";

type Query = typeof dbQuery;

/** Fragment SQL: rândul cu autorul `authorCol` NU e blocat de/nu îl blochează pe `$viewerParam`. */
export function notBlockedSql(authorCol: string, viewerParam: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM user_blocks ub
     WHERE (ub.blocker_user_id = ${viewerParam}::uuid AND ub.blocked_user_id = ${authorCol})
        OR (ub.blocker_user_id = ${authorCol} AND ub.blocked_user_id = ${viewerParam}::uuid)
  )`;
}

/** true dacă oricare dintre cei doi l-a blocat pe celălalt. */
export async function isBlockedEitherWay(a: string, b: string, query: Query = dbQuery): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const { rows } = await query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_blocks
        WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
           OR (blocker_user_id = $2 AND blocked_user_id = $1)
     ) AS blocked`,
    [a, b],
  );
  return Boolean(rows[0]?.blocked);
}

export type BlockState = { blockedByMe: boolean; blocksMe: boolean };

export async function getBlockState(viewerId: string | null, targetId: string): Promise<BlockState> {
  if (!viewerId || viewerId === targetId) return { blockedByMe: false, blocksMe: false };
  const { rows } = await dbQuery<{ blocker_user_id: string }>(
    `SELECT blocker_user_id FROM user_blocks
      WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
         OR (blocker_user_id = $2 AND blocked_user_id = $1)`,
    [viewerId, targetId],
  );
  return {
    blockedByMe: rows.some((r) => r.blocker_user_id === viewerId),
    blocksMe: rows.some((r) => r.blocker_user_id === targetId),
  };
}

/** Din `candidates`, id-urile care NU au blocare (în niciun sens) cu `userId`. */
export async function filterUnblocked(userId: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT c.id::text AS id
       FROM unnest($2::uuid[]) AS c(id)
      WHERE ${notBlockedSql("c.id", "$1")}`,
    [userId, candidates],
  );
  return rows.map((r) => r.id);
}

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  await withTransaction(async (q) => {
    await q(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [blockerId, blockedId],
    );
    await q(
      `DELETE FROM follows
        WHERE (follower_user_id = $1 AND following_user_id = $2)
           OR (follower_user_id = $2 AND following_user_id = $1)`,
      [blockerId, blockedId],
    );
  });
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await dbQuery(`DELETE FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2`, [
    blockerId,
    blockedId,
  ]);
}
