package controlkernel

import (
	"errors"
	"testing"
	"time"
)

func TestValidateExecutorLeaseBindsPrincipalAndLiveEpoch(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "untrusted-display-label", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	got, err := kernel.ValidateExecutorLease("executor-credential", "executor", "node", token)
	if err != nil || got.ID != lease.ID {
		t.Fatalf("valid executor: lease=%+v err=%v", got, err)
	}
	for _, input := range []struct{ credential, expected string }{
		{"invalid", "executor"},
		{"verifier-credential", "executor"},
		{"executor-credential", "untrusted-display-label"},
		{"executor-credential", ""},
	} {
		if _, err := kernel.ValidateExecutorLease(input.credential, input.expected, "node", token); !errors.Is(err, ErrExecutorUnauthorized) {
			t.Fatalf("credential=%q expected=%q err=%v", input.credential, input.expected, err)
		}
	}
	stale := token
	stale.Fence++
	if _, err := kernel.ValidateExecutorLease("executor-credential", "executor", "node", stale); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("stale lease err=%v", err)
	}
	clock.Add(time.Minute)
	if _, err := kernel.ValidateExecutorLease("executor-credential", "executor", "node", token); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("expired lease err=%v", err)
	}
}
