-- Connect imported videos to marketplace products and store viewer product verdicts.

CREATE TABLE IF NOT EXISTS video_product_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id text,
  vote text NOT NULL CHECK (vote IN ('worth_it', 'not_worth_it')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_product_votes_actor_check CHECK (
    user_id IS NOT NULL OR NULLIF(BTRIM(session_id), '') IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS video_product_votes_video_product_idx
  ON video_product_votes (video_id, product_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS video_product_votes_product_idx
  ON video_product_votes (product_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS video_product_votes_user_uidx
  ON video_product_votes (video_id, product_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS video_product_votes_session_uidx
  ON video_product_votes (video_id, product_id, session_id)
  WHERE user_id IS NULL AND session_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_video_product_votes_set_updated_at ON video_product_votes;
CREATE TRIGGER trg_video_product_votes_set_updated_at
  BEFORE UPDATE ON video_product_votes
  FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();

WITH product_ref_links AS (
  SELECT
    v.id AS video_id,
    mp.id AS product_id,
    CASE WHEN ref.ordinality = 1 THEN 'pinned' ELSE 'tagged' END AS placement,
    (ref.ordinality - 1)::integer AS sort_order,
    ref.value AS product_ref
  FROM videos v
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(COALESCE(v.product_refs, '[]'::jsonb)) = 'array' THEN COALESCE(v.product_refs, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS ref(value, ordinality)
  JOIN marketplace_products mp
    ON mp.id = CASE
      WHEN (
        CASE
          WHEN jsonb_typeof(ref.value) = 'object' THEN ref.value->>'product_id'
          WHEN jsonb_typeof(ref.value) = 'string' THEN TRIM(BOTH '"' FROM ref.value::text)
          ELSE NULL
        END
      ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (
        CASE
          WHEN jsonb_typeof(ref.value) = 'object' THEN ref.value->>'product_id'
          WHEN jsonb_typeof(ref.value) = 'string' THEN TRIM(BOTH '"' FROM ref.value::text)
          ELSE NULL
        END
      )::uuid
      ELSE NULL
    END
)
INSERT INTO video_product_links (video_id, product_id, placement, sort_order, metadata)
SELECT
  video_id,
  product_id,
  placement,
  sort_order,
  jsonb_strip_nulls(jsonb_build_object(
    'source', CASE WHEN jsonb_typeof(product_ref) = 'object' THEN product_ref->>'source' ELSE NULL END,
    'backfilled_from', 'videos.product_refs',
    'product_ref', product_ref
  ))
FROM product_ref_links
ON CONFLICT (video_id, product_id, placement, sort_order)
DO UPDATE SET
  metadata = video_product_links.metadata || EXCLUDED.metadata,
  updated_at = now();
