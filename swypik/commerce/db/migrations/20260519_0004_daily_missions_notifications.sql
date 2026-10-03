-- 20260519_0004_daily_missions_notifications.sql
-- Daily mission engine + notification queue.
-- Templates rotate; each user gets 3-5 instantiated missions per day,
-- pulled by GET /api/me/missions, claimed by POST /api/me/missions/:id/claim.

BEGIN;

CREATE TABLE IF NOT EXISTS daily_mission_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  title           text NOT NULL,
  description     text,
  -- 'vote_battles'|'cast_merita_votes'|'post_clip'|'save_products'|'comment'|'invite_friend'|'open_app'|'view_arena'|'spend_coins'
  kind            text NOT NULL,
  target          integer NOT NULL DEFAULT 1 CHECK (target > 0),
  reward_xp       integer NOT NULL DEFAULT 0,
  reward_coins    integer NOT NULL DEFAULT 0,
  reward_reputation numeric(6,2) NOT NULL DEFAULT 0,
  -- Bitmask 0..127 of weekdays this mission is eligible to be picked (0=Mon).
  weekday_mask    integer NOT NULL DEFAULT 127,
  weight          integer NOT NULL DEFAULT 100, -- selection weight in the picker
  min_level       integer NOT NULL DEFAULT 1,
  is_active       boolean NOT NULL DEFAULT TRUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mission_templates_active
  ON daily_mission_templates(is_active, min_level) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS user_daily_missions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id     uuid NOT NULL REFERENCES daily_mission_templates(id) ON DELETE CASCADE,
  day             date NOT NULL,
  target          integer NOT NULL,
  progress        integer NOT NULL DEFAULT 0,
  completed_at    timestamptz,
  claimed_at      timestamptz,
  reward_xp       integer NOT NULL,
  reward_coins    integer NOT NULL,
  reward_reputation numeric(6,2) NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, template_id, day)
);

CREATE INDEX IF NOT EXISTS idx_user_missions_day
  ON user_daily_missions(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_user_missions_open
  ON user_daily_missions(user_id, day) WHERE claimed_at IS NULL;

-- Generic notification queue. Polled by client (websocket layer later).
CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'battle_overtaken'|'trending_chance'|'mission_complete'|'mission_assigned'|'bounty_won'|'comment_reply'|'streak_warning'|'follow'|'product_reply'|'drop_live'
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  ref_type    text,
  ref_id      uuid,
  cta_url     text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_recent
  ON notifications(user_id, created_at DESC);

-- Seed a handful of useful templates so /api/me/missions has data to draw from.
INSERT INTO daily_mission_templates(slug, title, description, kind, target, reward_xp, reward_coins) VALUES
  ('vote_5_battles',   'Votează în 5 battles',          'Intră în 5 dueluri și votează ce merită.',   'vote_battles',     5, 50, 25),
  ('vote_10_merita',   'Spune Merită la 10 produse',    'Dă-ți părerea despre 10 produse din feed.',  'cast_merita_votes',10, 40, 20),
  ('post_1_clip',      'Postează 1 clip',               'Filmează o reacție, un test sau un unboxing.','post_clip',       1, 150, 75),
  ('save_3_products',  'Salvează 3 produse',            'Construiește-ți wishlist-ul de săptămâna asta.','save_products',  3, 20, 10),
  ('open_arena',       'Intră în Arena',                'Verifică battle-urile zilei.',                'view_arena',      1, 10, 5),
  ('comment_3',        'Comentează 3 postări',          'Spune-ți părerea acolo unde contează.',       'comment',         3, 30, 15),
  ('invite_1_friend',  'Invită 1 prieten',              'Trimite-i un link de invitație.',             'invite_friend',   1, 100, 50),
  ('spend_50_coins',   'Cheltuie 50 Swyp Coins',        'Reduceri, boost sau o mostră de la un seller.','spend_coins',    50, 30, 0)
ON CONFLICT (slug) DO NOTHING;

-- Pick & instantiate N missions for a user for a given day. Idempotent.
CREATE OR REPLACE FUNCTION daily_missions_assign(p_user_id uuid, p_count integer DEFAULT 4)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Bucharest')::date;
  v_existing integer;
  v_inserted integer := 0;
  v_level integer;
BEGIN
  INSERT INTO user_wallets(user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT level INTO v_level FROM user_wallets WHERE user_id = p_user_id;

  SELECT COUNT(*) INTO v_existing FROM user_daily_missions WHERE user_id = p_user_id AND day = v_today;
  IF v_existing >= p_count THEN RETURN 0; END IF;

  INSERT INTO user_daily_missions(user_id, template_id, day, target, reward_xp, reward_coins, reward_reputation)
  SELECT p_user_id, t.id, v_today, t.target, t.reward_xp, t.reward_coins, t.reward_reputation
    FROM daily_mission_templates t
   WHERE t.is_active = TRUE
     AND t.min_level <= COALESCE(v_level, 1)
     AND NOT EXISTS (
       SELECT 1 FROM user_daily_missions u
        WHERE u.user_id = p_user_id AND u.day = v_today AND u.template_id = t.id
     )
   ORDER BY random() * t.weight DESC
   LIMIT GREATEST(p_count - v_existing, 0);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END $$;

-- Progress + maybe complete a mission. Returns whether it transitioned to complete.
CREATE OR REPLACE FUNCTION daily_missions_progress(
  p_user_id uuid, p_kind text, p_amount integer DEFAULT 1
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Bucharest')::date;
  v_completed_count integer;
BEGIN
  WITH updated AS (
    UPDATE user_daily_missions m
       SET progress = LEAST(target, progress + p_amount),
           completed_at = CASE WHEN completed_at IS NULL AND (progress + p_amount) >= target THEN now() ELSE completed_at END
      FROM daily_mission_templates t
     WHERE m.template_id = t.id
       AND m.user_id = p_user_id
       AND m.day = v_today
       AND m.completed_at IS NULL
       AND t.kind = p_kind
    RETURNING m.id, m.completed_at
  )
  SELECT COUNT(*) INTO v_completed_count FROM updated WHERE completed_at IS NOT NULL;

  -- Emit a notification for each freshly completed mission.
  INSERT INTO notifications(user_id, kind, title, body, ref_type, ref_id, cta_url)
  SELECT p_user_id, 'mission_complete', 'Misiune completă',
         t.title || ' — revendică recompensa.', 'mission', m.id, '/missions/daily'
    FROM user_daily_missions m
    JOIN daily_mission_templates t ON t.id = m.template_id
   WHERE m.user_id = p_user_id
     AND m.day = v_today
     AND m.completed_at IS NOT NULL
     AND m.claimed_at IS NULL
     AND m.completed_at > now() - interval '5 seconds';

  RETURN COALESCE(v_completed_count, 0);
END $$;

COMMIT;
