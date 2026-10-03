/** One statement: a concurrent refresh can consume the old session only once. */
export const ROTATE_BEARER_SQL = `
WITH consumed AS (
  UPDATE user_sessions AS s SET revoked_at = now()
  FROM users AS u
  WHERE s.session_token_hash = $1 AND s.kind = 'bearer'
    AND s.revoked_at IS NULL AND s.expires_at > now()
    AND u.id = s.user_id
    AND COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')
    AND (u.suspended_until IS NULL OR u.suspended_until <= now())
  RETURNING s.user_id
)
INSERT INTO user_sessions (user_id, session_token_hash, kind, user_agent, expires_at, metadata)
SELECT user_id, $2, 'bearer', $3, now() + interval '30 days', $4::jsonb FROM consumed
RETURNING user_id, expires_at`;
