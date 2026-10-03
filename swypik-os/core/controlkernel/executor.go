package controlkernel

import "fmt"

// ValidateExecutorLease authenticates a worker and validates its current
// execution epoch under the same control-kernel lock. A lease ID and display
// owner label are not sufficient to act as another executor.
func (k *Kernel) ValidateExecutorLease(credential, expectedExecutorID, nodeID string, token LeaseToken) (Lease, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Lease{}, err
	}
	if k.executorAuthenticator == nil {
		return Lease{}, fmt.Errorf("%w: no executor authenticator configured", ErrExecutorUnauthorized)
	}
	principal, err := k.executorAuthenticator.AuthenticateExecutor(credential)
	if err != nil || principal.ID == "" || expectedExecutorID == "" || principal.ID != expectedExecutorID {
		return Lease{}, fmt.Errorf("%w: authenticated executor does not match expected identity", ErrExecutorUnauthorized)
	}
	lease, err := k.validateLeaseLocked(nodeID, token)
	if err != nil {
		return Lease{}, err
	}
	if lease.ExecutorID != principal.ID {
		return Lease{}, fmt.Errorf("%w: lease belongs to a different executor", ErrExecutorUnauthorized)
	}
	return lease, nil
}
