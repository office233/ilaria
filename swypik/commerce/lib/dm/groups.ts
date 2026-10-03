import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { DM_CONFIG } from "./config";
import { requireParticipant } from "./repository";
import { statusError } from "./types";

export type GroupMember = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  joined_at: string;
};

async function requireGroupAdmin(
  q: TxQuery,
  conversationId: string,
  actorId: string,
): Promise<void> {
  const { rows } = await q<{ is_admin: boolean }>(
    `SELECT cp.is_admin
       FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conversation_id
      WHERE cp.conversation_id = $1
        AND cp.user_id = $2
        AND c.kind = 'group'
      LIMIT 1`,
    [conversationId, actorId],
  );
  if (!rows[0]) throw statusError("Group not found", 404, "group_not_found");
  if (!rows[0].is_admin) throw statusError("Admin required", 403, "admin_required");
}

export async function listGroupMembers(
  conversationId: string,
  viewerId: string,
): Promise<GroupMember[]> {
  await requireParticipant(conversationId, viewerId);
  const { rows } = await dbQuery<GroupMember>(
    `SELECT cp.user_id, u.username, u.display_name,
            COALESCE(cpr.avatar_url, u.avatar_url) AS avatar_url,
            cp.is_admin, cp.joined_at
       FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conversation_id AND c.kind = 'group'
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN creator_profiles cpr ON cpr.user_id = u.id
      WHERE cp.conversation_id = $1
      ORDER BY cp.is_admin DESC, cp.joined_at, cp.user_id`,
    [conversationId],
  );
  return rows;
}

export async function addGroupMembers(
  conversationId: string,
  actorId: string,
  userIds: string[],
): Promise<number> {
  const unique = [...new Set(userIds.filter((id) => id && id !== actorId))];
  if (!unique.length) throw statusError("No members", 400, "invalid_members");

  return withTransaction(async (q) => {
    await requireGroupAdmin(q, conversationId, actorId);
    const { rows: existing } = await q<{ user_id: string }>(
      `SELECT user_id
         FROM conversation_participants
        WHERE conversation_id = $1 AND user_id = ANY($2::uuid[])`,
      [conversationId, unique],
    );
    const existingIds = new Set(existing.map((row) => row.user_id));
    const candidates = unique.filter((id) => !existingIds.has(id));
    if (!candidates.length) return 0;

    const { rows: countRows } = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM conversation_participants WHERE conversation_id = $1`,
      [conversationId],
    );
    const currentCount = Number(countRows[0]?.n ?? 0);
    if (currentCount + candidates.length > DM_CONFIG.maxGroupMembers) {
      throw statusError("Group member limit", 409, "group_member_limit");
    }

    const { rows: users } = await q<{ id: string }>(
      `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [candidates],
    );
    if (users.length !== candidates.length) {
      throw statusError("Participant not found", 404, "participant_not_found");
    }

    const { rows: blocked } = await q(
      `SELECT 1
         FROM user_blocks
        WHERE (blocker_user_id = $1 AND blocked_user_id = ANY($2::uuid[]))
           OR (blocked_user_id = $1 AND blocker_user_id = ANY($2::uuid[]))
        LIMIT 1`,
      [actorId, candidates],
    );
    if (blocked.length) throw statusError("Blocked participant", 403, "blocked");

    const { rowCount } = await q(
      `INSERT INTO conversation_participants (conversation_id, user_id, role, is_admin)
       SELECT $1, id, 'member', false
         FROM users
        WHERE id = ANY($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [conversationId, candidates],
    );
    return rowCount ?? 0;
  });
}

export async function removeGroupMember(
  conversationId: string,
  actorId: string,
  userId: string,
): Promise<void> {
  await withTransaction(async (q) => {
    const selfLeave = actorId === userId;
    if (!selfLeave) await requireGroupAdmin(q, conversationId, actorId);

    const { rows } = await q<{ is_admin: boolean }>(
      `SELECT cp.is_admin
         FROM conversation_participants cp
         JOIN conversations c ON c.id = cp.conversation_id AND c.kind = 'group'
        WHERE cp.conversation_id = $1 AND cp.user_id = $2
        FOR UPDATE`,
      [conversationId, userId],
    );
    const member = rows[0];
    if (!member) throw statusError("Member not found", 404, "member_not_found");

    if (member.is_admin) {
      const { rows: admins } = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM conversation_participants
          WHERE conversation_id = $1 AND is_admin = true`,
        [conversationId],
      );
      if (Number(admins[0]?.n ?? 0) <= 1) {
        throw statusError("Last admin", 409, "last_admin");
      }
    }

    await q(
      `DELETE FROM conversation_participants
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
  });
}

export async function setGroupAdmin(
  conversationId: string,
  actorId: string,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  await withTransaction(async (q) => {
    await requireGroupAdmin(q, conversationId, actorId);
    if (!isAdmin) {
      const { rows } = await q<{ target_admin: boolean; admin_count: number }>(
        `SELECT cp.is_admin AS target_admin,
                (SELECT COUNT(*)::int
                   FROM conversation_participants
                  WHERE conversation_id = $1 AND is_admin = true) AS admin_count
           FROM conversation_participants cp
          WHERE cp.conversation_id = $1 AND cp.user_id = $2
          FOR UPDATE`,
        [conversationId, userId],
      );
      const state = rows[0];
      if (!state) throw statusError("Member not found", 404, "member_not_found");
      if (state.target_admin && Number(state.admin_count) <= 1) {
        throw statusError("Last admin", 409, "last_admin");
      }
    }
    const { rowCount } = await q(
      `UPDATE conversation_participants
          SET is_admin = $3,
              role = CASE WHEN $3 THEN 'admin' ELSE 'member' END
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId, isAdmin],
    );
    if (!rowCount) throw statusError("Member not found", 404, "member_not_found");
  });
}
