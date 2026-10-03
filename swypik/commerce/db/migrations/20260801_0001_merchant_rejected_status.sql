-- Onboarding restaurante: permite status 'rejected' pe local_merchants.
-- Idempotent.
ALTER TABLE local_merchants DROP CONSTRAINT IF EXISTS local_merchants_status_check;
ALTER TABLE local_merchants ADD CONSTRAINT local_merchants_status_check
  CHECK (status IN ('pending', 'active', 'suspended', 'closed', 'rejected'));
