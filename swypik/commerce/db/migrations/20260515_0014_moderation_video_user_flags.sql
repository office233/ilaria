-- Moderation: soft hide for videos + suspension for users
ALTER TABLE videos ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_videos_visible ON videos(status, is_hidden) WHERE status = 'ready' AND is_hidden = false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason text;
CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(suspended_until) WHERE suspended_until IS NOT NULL;
