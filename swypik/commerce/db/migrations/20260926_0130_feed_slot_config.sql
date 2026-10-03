-- 20260926_0130_feed_slot_config
--
-- Sloturile cardurilor de modul în feed-ul video unificat (lib/feed/slots.ts).
-- Un card de tipul `kind` e datorat pe pozițiile p ≥ first_slot cu
-- (p − first_slot) % every_n = 0; max_per_page limitează tipul într-o pagină;
-- priority mai mic câștigă la coliziune. Override din env: FEED_SLOT_<KIND>=
-- "every,first,max" sau "off". Modificabil live (cache 60s), fără redeploy.
-- Idempotent; nu șterge nimic.

BEGIN;

CREATE TABLE IF NOT EXISTS feed_slot_config (
  kind          text PRIMARY KEY
                CHECK (kind IN ('product', 'food', 'movie', 'music', 'stay', 'live', 'news')),
  every_n       integer NOT NULL CHECK (every_n >= 2),
  first_slot    integer NOT NULL CHECK (first_slot >= 1),
  max_per_page  integer NOT NULL DEFAULT 1 CHECK (max_per_page >= 0),
  enabled       boolean NOT NULL DEFAULT true,
  priority      integer NOT NULL DEFAULT 100,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE feed_slot_config IS
  'Sloturile cardurilor de modul (product/food/movie/music/stay/live/news) intercalate în feed-ul video — lib/feed/slots.ts';

INSERT INTO feed_slot_config (kind, every_n, first_slot, max_per_page, enabled, priority) VALUES
  ('live',    12,  2, 1, true, 10),
  ('product',  7,  4, 3, true, 20),
  ('movie',   13,  9, 1, true, 30),
  ('music',   17, 11, 1, true, 40),
  ('stay',    19, 15, 1, true, 50),
  ('food',    23, 20, 1, true, 60),
  ('news',    10,  7, 1, true, 70)
ON CONFLICT (kind) DO NOTHING;

COMMIT;
