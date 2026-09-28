-- 20260514_direct_messages.sql
-- Creator <-> user direct messaging schema.
-- Idempotent: safe to re-run.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Conversations: dm (2-person) or group.
CREATE TABLE IF NOT EXISTS conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm', 'group')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW()
);

-- Participants membership (PK is composite).
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL DEFAULT 'member',
  joined_at        timestamptz NOT NULL DEFAULT NOW(),
  last_read_at     timestamptz,
  muted_until      timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

-- Messages.
CREATE TABLE IF NOT EXISTS messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id             uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  body                  text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  media_url             text,
  reply_to_message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','edited','deleted')),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conv_created_idx
  ON messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conv_participants_user_conv_idx
  ON conversation_participants (user_id, conversation_id);

CREATE INDEX IF NOT EXISTS conversations_last_msg_idx
  ON conversations (last_message_at DESC)
  WHERE last_message_at IS NOT NULL;

-- get_or_create_dm: find or create the unique 2-person dm between (a,b).
CREATE OR REPLACE FUNCTION get_or_create_dm(uuid_a uuid, uuid_b uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_conv_id uuid;
BEGIN
  IF uuid_a IS NULL OR uuid_b IS NULL OR uuid_a = uuid_b THEN
    RAISE EXCEPTION 'get_or_create_dm: invalid participants';
  END IF;

  SELECT c.id
    INTO v_conv_id
    FROM conversations c
    JOIN conversation_participants pa ON pa.conversation_id = c.id AND pa.user_id = uuid_a
    JOIN conversation_participants pb ON pb.conversation_id = c.id AND pb.user_id = uuid_b
   WHERE c.kind = 'dm'
     AND (SELECT COUNT(*) FROM conversation_participants p WHERE p.conversation_id = c.id) = 2
   LIMIT 1;

  IF v_conv_id IS NOT NULL THEN
    RETURN v_conv_id;
  END IF;

  INSERT INTO conversations (kind, created_by)
    VALUES ('dm', uuid_a)
    RETURNING id INTO v_conv_id;

  INSERT INTO conversation_participants (conversation_id, user_id)
    VALUES (v_conv_id, uuid_a), (v_conv_id, uuid_b)
    ON CONFLICT DO NOTHING;

  RETURN v_conv_id;
END;
$$;

COMMIT;
