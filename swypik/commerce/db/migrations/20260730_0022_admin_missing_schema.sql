-- Repară schema lipsă care rupea paginile admin:
--   1. stripe_disputes — scrisă de webhook-ul Stripe, citită de /admin/disputes,
--      /admin/risk și OpsAlertsBar; tabela nu a fost niciodată creată.
--   2. couriers.active — folosită de /admin/fleet (suspendare curier).

CREATE TABLE IF NOT EXISTS stripe_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id TEXT NOT NULL UNIQUE,
    charge_id TEXT NOT NULL DEFAULT '',
    payment_intent_id TEXT,
    order_id UUID,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'ron',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'needs_response',
    evidence_due_by TIMESTAMPTZ,
    is_charge_refundable BOOLEAN NOT NULL DEFAULT false,
    evidence_submitted BOOLEAN NOT NULL DEFAULT false,
    evidence_submitted_at TIMESTAMPTZ,
    evidence_data JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_disputes_status ON stripe_disputes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_order ON stripe_disputes (order_id) WHERE order_id IS NOT NULL;

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
