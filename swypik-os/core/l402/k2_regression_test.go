package l402

import (
	"errors"
	"fmt"
	"testing"
)

func TestRegressionK2SettledInvoiceNotEvicted(t *testing.T) {
	key := []byte("SWYPIK_L402_ROOT_KEY_K2_REGRESSION")
	engine := NewSettlementEngine(key)

	// 1. Generate challenge and settle it
	challenge1, preimage1, err := engine.GenerateChallenge(10, "Target Settled Invoice")
	if err != nil {
		t.Fatalf("failed to generate first challenge: %v", err)
	}
	if err := engine.SettleInvoice(challenge1.Invoice.PaymentHash, preimage1); err != nil {
		t.Fatalf("failed to settle first challenge: %v", err)
	}

	// 2. Generate capacity + N challenges without settling them
	const extraChallenges = 50
	totalToGenerate := MaxInvoicesCapacity + extraChallenges
	for i := 0; i < totalToGenerate; i++ {
		_, _, err := engine.GenerateChallenge(10, fmt.Sprintf("Unsettled Flood %d", i))
		if err != nil {
			t.Fatalf("failed generating challenge %d: %v", i, err)
		}
	}

	// 3. VerifyL402Auth for the settled invoice must still succeed (never evicted)
	valid, err := engine.VerifyL402Auth(challenge1.Token, preimage1)
	if !valid || err != nil {
		t.Fatalf("expected settled invoice to survive eviction after %d challenges, valid=%v, err=%v", totalToGenerate, valid, err)
	}
}

func TestRegressionK2CapacityExceededWithSettledInvoices(t *testing.T) {
	key := []byte("SWYPIK_L402_ROOT_KEY_K2_CAPACITY")
	engine := NewSettlementEngine(key)

	// Fill engine to full capacity with settled invoices
	for i := 0; i < MaxInvoicesCapacity; i++ {
		c, pre, err := engine.GenerateChallenge(10, fmt.Sprintf("Settled Item %d", i))
		if err != nil {
			t.Fatalf("unexpected error creating challenge %d: %v", i, err)
		}
		if err := engine.SettleInvoice(c.Invoice.PaymentHash, pre); err != nil {
			t.Fatalf("failed to settle invoice %d: %v", i, err)
		}
	}

	// Attempting to create one more challenge must fail with ErrCapacityExceeded
	_, _, err := engine.GenerateChallenge(10, "Overflow Challenge")
	if err == nil || !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("expected ErrCapacityExceeded when store is filled with live settled invoices, got: %v", err)
	}
}
