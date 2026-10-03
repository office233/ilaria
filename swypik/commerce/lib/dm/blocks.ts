/**
 * Blocări în Messenger — aceeași sursă ca restul platformei (lib/social/blocks.ts:
 * la blocare se șterg și follow-urile). Aici doar forma folosită de DM.
 */
import { dbQuery } from "@/lib/db";
import { getBlockState as getSocialBlockState } from "@/lib/social/blocks";

export { blockUser, isBlockedEitherWay, unblockUser } from "@/lib/social/blocks";

export type BlockState = { blockedByMe: boolean; blockedMe: boolean };

/** Starea de blocare între viewer și peer, în ambele sensuri. */
export async function getBlockState(viewerId: string, peerId: string): Promise<BlockState> {
  const s = await getSocialBlockState(viewerId, peerId);
  return { blockedByMe: s.blockedByMe, blockedMe: s.blocksMe };
}

export async function userExists(userId: string): Promise<boolean> {
  const { rows } = await dbQuery(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [userId]);
  return rows.length > 0;
}
