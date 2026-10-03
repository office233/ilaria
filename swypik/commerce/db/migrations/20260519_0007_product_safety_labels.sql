-- Trust & Safety: product_safety_labels
-- 4-level safety classification for marketplace_products.
-- Replaces the boolean is_adult with a richer { safe | sensitive | adult | blocked } label.
--
-- Filter rule in Swypik general (swypik.com):  label = 'safe'  (zero tolerance)
-- Filter rule in Swypik 18+ (18.swypik.com):   label IN ('adult')  (only verified adults)
-- 'blocked' is NEVER served anywhere.
-- 'sensitive' is hidden by default; surface only on explicit opt-in flow.

CREATE TABLE IF NOT EXISTS product_safety_labels (
  product_id           UUID PRIMARY KEY REFERENCES marketplace_products(id) ON DELETE CASCADE,
  label                TEXT NOT NULL CHECK (label IN ('safe', 'sensitive', 'adult', 'blocked')),
  classifier_version   TEXT NOT NULL DEFAULT 'v2',
  signals              JSONB NOT NULL DEFAULT '{}'::jsonb,
  reasons              TEXT[] NOT NULL DEFAULT '{}',
  reviewed_by_human    BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at          TIMESTAMPTZ,
  reviewed_by_user_id  UUID REFERENCES users(id),
  human_override_label TEXT CHECK (human_override_label IN ('safe', 'sensitive', 'adult', 'blocked')),
  classified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_safety_labels_label
  ON product_safety_labels(label);
CREATE INDEX IF NOT EXISTS idx_product_safety_labels_unreviewed
  ON product_safety_labels(label, classified_at)
  WHERE reviewed_by_human = FALSE AND label IN ('sensitive', 'adult');

-- Touch trigger
CREATE OR REPLACE FUNCTION trg_product_safety_labels_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_safety_labels_touch ON product_safety_labels;
CREATE TRIGGER product_safety_labels_touch
  BEFORE UPDATE ON product_safety_labels
  FOR EACH ROW EXECUTE FUNCTION trg_product_safety_labels_touch();

-- Helper view: effective label (human override wins if present)
CREATE OR REPLACE VIEW product_effective_safety AS
SELECT
  product_id,
  COALESCE(human_override_label, label) AS effective_label,
  reviewed_by_human,
  classified_at,
  updated_at
FROM product_safety_labels;

COMMENT ON TABLE product_safety_labels IS
  'Trust & Safety classification per product. Filter `effective_label=safe` in Swypik general; only `effective_label=adult` shown on Swypik 18+ to verified users.';
