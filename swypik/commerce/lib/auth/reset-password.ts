import { withTransaction, type TxQuery } from "@/lib/db";

/** The conditional UPDATE locks and consumes a reset token exactly once. */
export async function resetPasswordInTransaction(
  query: TxQuery,
  tokenHash: string,
  passwordHash: string,
): Promise<boolean> {
  const { rows } = await query<{ user_id: string }>(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [tokenHash],
  );
  if (!rows[0]) return false;
  const userId = rows[0].user_id;
  await query(
    "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
    [passwordHash, userId],
  );
  await query(
    "UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  return true;
}

export function resetPasswordWithToken(tokenHash: string, passwordHash: string): Promise<boolean> {
  return withTransaction((query) => resetPasswordInTransaction(query, tokenHash, passwordHash));
}
