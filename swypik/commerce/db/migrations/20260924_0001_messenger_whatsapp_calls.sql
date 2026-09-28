-- 20260924_0001_messenger_whatsapp_calls.sql
-- WhatsApp-grade Messenger & Audio/Video Call Sessions schema for Swypik

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Actualizare / Extindere tipuri conversație
ALTER TABLE conversations 
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Actualizare participanți (permisiuni grup + stări livrare)
ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS last_delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- 3. Tipuri de mesaje (text, imagine, video, audio/voce, document, apel)
DO $$ BEGIN
  CREATE TYPE messenger_message_type AS ENUM (
    'text', 'image', 'video', 'voice_note', 'audio', 'document', 'call_event', 'system'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 4. Actualizare tabel mesaje
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type messenger_message_type NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS attachment_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_duration_seconds integer,
  ADD COLUMN IF NOT EXISTS is_forwarded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_starred boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_for_everyone boolean NOT NULL DEFAULT false;

-- 5. Tabel pentru starea fiecărui mesaj per participant (Delivered, Read)
-- Permite afișarea precisă a bifelor (Sent = 1 gri, Delivered = 2 gri, Read = 2 albastre)
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id       uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at     timestamptz,
  read_at          timestamptz,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_receipts_user_read 
  ON message_receipts(user_id, read_at) 
  WHERE read_at IS NULL;

-- 6. Tabel Reacții la Mesaje (Reactions stil WhatsApp: 👍, ❤️, 😂, 😮, 😢, 🙏)
CREATE TABLE IF NOT EXISTS message_reactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji           text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 8),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_message_user_reaction UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_msg 
  ON message_reactions(message_id);

-- 7. Sesiuni și Istoric Apeluri Audio / Video
DO $$ BEGIN
  CREATE TYPE call_type_enum AS ENUM ('audio', 'video');
  CREATE TYPE call_status_enum AS ENUM (
    'initiating', 'ringing', 'accepted', 'rejected', 'missed', 'busy', 'ended', 'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS call_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid REFERENCES conversations(id) ON DELETE SET NULL,
  caller_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_type             call_type_enum NOT NULL DEFAULT 'video',
  status                call_status_enum NOT NULL DEFAULT 'initiating',
  livekit_room_name     text UNIQUE NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  answered_at           timestamptz,
  ended_at              timestamptz,
  duration_seconds      integer DEFAULT 0,
  end_reason            text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_caller ON call_sessions(caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_conv ON call_sessions(conversation_id, started_at DESC);

-- Participanții la apel (suportă atât 1-la-1 cât și apel de grup)
CREATE TABLE IF NOT EXISTS call_participants (
  call_id         uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          call_status_enum NOT NULL DEFAULT 'ringing',
  joined_at       timestamptz,
  left_at         timestamptz,
  PRIMARY KEY (call_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id, status);

-- Trigger pentru actualizarea duratei la finalul apelului
CREATE OR REPLACE FUNCTION update_call_session_duration()
RETURNS trigger AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL AND NEW.answered_at IS NOT NULL THEN
    NEW.duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NEW.ended_at - NEW.answered_at))::int);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calc_call_duration ON call_sessions;
CREATE TRIGGER trg_calc_call_duration
  BEFORE UPDATE ON call_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_call_session_duration();

COMMIT;
