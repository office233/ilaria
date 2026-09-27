package l402

import (
	"testing"
)

func TestL402MicroSettlementAndProcurement(t *testing.T) {
	key := []byte("SWYPIK_L402_ROOT_KEY_2026")
	engine := NewSettlementEngine(key)

	// 1. Generate L402 HTTP 402 challenge for 25 satoshis
	challenge, preimage, err := engine.GenerateChallenge(25, "Offload 3D Diffusion Chunk (INT4)")
	if err != nil {
		t.Fatalf("Failed to generate L402 challenge: %v", err)
	}

	if challenge.Invoice.AmountSats != 25 || challenge.Token.Signature == "" {
		t.Errorf("Invalid challenge structure: %+v", challenge)
	}

	// Verification before settlement must fail
	valid, err := engine.VerifyL402Auth(challenge.Token, preimage)
	if valid || err == nil {
		t.Errorf("Verification must fail before invoice is settled")
	}

	// 2. Settle the invoice using the cryptographic preimage
	err = engine.SettleInvoice(challenge.Invoice.PaymentHash, preimage)
	if err != nil {
		t.Fatalf("Settlement failed: %v", err)
	}

	// Verification after settlement must succeed
	valid, err = engine.VerifyL402Auth(challenge.Token, preimage)
	if !valid || err != nil {
		t.Errorf("Expected valid L402 auth after settlement, err: %v", err)
	}

	// Check metrics
	count, sats := engine.GetMetrics()
	if count != 1 || sats != 25 {
		t.Errorf("Unexpected metrics: count=%d, sats=%d", count, sats)
	}

	// 3. Test Autonomous Component Procurement
	// Normal machine state (low vibration 0.2G, 50 hours) -> No procurement
	poNormal, needed := engine.EvaluateMaintenanceAndProcure(0.2, 50.0, "CNC_MILL_01")
	if needed || poNormal != nil {
		t.Errorf("Procurement should not trigger under healthy operational conditions")
	}

	// Degraded machine state (severe vibration 4.2G, 800 hours) -> Bearing failure imminent
	poDegraded, needed := engine.EvaluateMaintenanceAndProcure(4.2, 800.0, "CNC_MILL_01")
	if !needed || poDegraded == nil {
		t.Fatalf("Expected autonomous procurement to trigger for degraded machine")
	}

	if poDegraded.EstimatedRUL > 150.0 || poDegraded.PartNumber != "BRG-6205-2RSH" {
		t.Errorf("Unexpected purchase order: %+v", poDegraded)
	}
	if poDegraded.Status != "DISPATCHED_TO_DELIVERY_DRONE" {
		t.Errorf("Expected automated drone dispatch status, got: %s", poDegraded.Status)
	}
}
