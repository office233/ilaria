-- ============================================================================
-- Migration: 20260515 User age fields
-- Purpose: Per-user age verification status + opt-in toggle for adult content
-- Depends on: 20260514_0001_adult_content.sql (user_age_verifications table)
-- ============================================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS birth_date date,
  ADD COLUMN IF NOT EXISTS age_verification_status text
    CHECK (age_verification_status IN ('none','pending','approved','rejected','expired'))
    DEFAULT 'none' NOT NULL,
  ADD COLUMN IF NOT EXISTS age_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS adult_content_opt_in boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_age_verified
  ON users(id) WHERE age_verification_status = 'approved';

COMMIT;
