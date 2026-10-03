package controlkernel

import (
	"errors"
	"testing"
	"time"
)

func TestRegressionK1UncertainReconcilingAuthority(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")

	lease, err := kernel.ClaimLease("node", "executor-credential", "worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}

	if err := kernel.TransitionNode("node", NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	// EXECUTING -> UNCERTAIN with its lease
	if err := kernel.TransitionNode("node", NodeUncertain, token); err != nil {
		t.Fatal(err)
	}

	// Repro step 1: TransitionNode(n, RECONCILING, LeaseToken{}) with live lease must fail (missing/unauthorized lease)
	if err := kernel.TransitionNode("node", NodeReconciling, LeaseToken{}); err == nil {
		t.Fatal("expected error transitioning UNCERTAIN -> RECONCILING with empty lease token while lease is live")
	}

	// Transitioning to RECONCILING with the valid lease token succeeds
	if err := kernel.TransitionNode("node", NodeReconciling, token); err != nil {
		t.Fatalf("expected valid token to allow transition to RECONCILING: %v", err)
	}

	// Repro step 2: TransitionNode(n, SUCCEEDED, ...) with 0 verifications and 0 intents must fail
	if err := kernel.TransitionNode("node", NodeSucceeded, token); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict transitioning RECONCILING -> SUCCEEDED with 0 verifications/intents, got %v", err)
	}
	if err := kernel.TransitionNode("node", NodeSucceeded, LeaseToken{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict transitioning RECONCILING -> SUCCEEDED with empty token and 0 verifications/intents, got %v", err)
	}

	node, _ := kernel.Node("node")
	if node.State == NodeSucceeded {
		t.Fatalf("node reached SUCCEEDED without verifications or intents")
	}
}
