package controlkernel

import (
	"fmt"
	"strings"

	controlkernelcontract "swypik-os/generated/controlkernel"
)

// ResourceState is generated from specs/control-kernel.swyp. The control
// kernel owns Revision and ObservedAtUnixMS when it persists a state.
type ResourceState = controlkernelcontract.ResourceState

func cloneResourceState(state ResourceState) ResourceState {
	state.Reasons = append([]string(nil), state.Reasons...)
	return state
}

func validateResourceState(state ResourceState) error {
	switch state.Profile {
	case "phone", "balanced", "performance":
	default:
		return fmt.Errorf("invalid resource profile %q", state.Profile)
	}
	switch state.DeviceClass {
	case "", "unknown", "workstation", "mobile", "automotive", "robot", "appliance", "embedded":
	default:
		return fmt.Errorf("invalid resource device class %q", state.DeviceClass)
	}
	if state.BaseBackgroundCPUPercent < 1 || state.BaseBackgroundCPUPercent > 100 ||
		state.BaseBackgroundGPUPercent < 1 || state.BaseBackgroundGPUPercent > 100 ||
		state.BaseBackgroundWorkers < 1 {
		return fmt.Errorf("invalid base resource envelope")
	}
	if state.MaxBackgroundCPUPercent < 1 || state.MaxBackgroundCPUPercent > state.BaseBackgroundCPUPercent ||
		state.MaxBackgroundGPUPercent < 1 || state.MaxBackgroundGPUPercent > state.BaseBackgroundGPUPercent ||
		state.MaxBackgroundWorkers < 1 || state.MaxBackgroundWorkers > state.BaseBackgroundWorkers {
		return fmt.Errorf("effective resource state exceeds base envelope")
	}
	if state.Revision == 0 || state.ObservedAtUnixMS <= 0 {
		return fmt.Errorf("resource state authority metadata is missing")
	}
	if len(state.Reasons) > 16 {
		return fmt.Errorf("too many resource pressure reasons")
	}
	for _, reason := range state.Reasons {
		reason = strings.TrimSpace(reason)
		if reason == "" || len(reason) > 64 {
			return fmt.Errorf("invalid resource pressure reason")
		}
	}
	return nil
}

// RecordResourceState durably records the effective background-compute
// authority. Revision and observation time come from the kernel, not the
// caller, so replay has one monotonic source of truth.
func (k *Kernel) RecordResourceState(state ResourceState) (ResourceState, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return ResourceState{}, err
	}

	state = cloneResourceState(state)
	state.Revision = 1
	if k.projection.HasResourceState {
		state.Revision = k.projection.ResourceState.Revision + 1
	}
	state.ObservedAtUnixMS = k.now().UTC().UnixMilli()
	if err := validateResourceState(state); err != nil {
		return ResourceState{}, err
	}
	event, err := k.makeEvent(eventResourceStateRecorded, state)
	if err != nil {
		return ResourceState{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return ResourceState{}, err
	}
	return cloneResourceState(state), nil
}

// CurrentResourceState returns the last durable background-compute authority.
// The returned reasons slice is detached from the projection.
func (k *Kernel) CurrentResourceState() (ResourceState, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.projection.HasResourceState {
		return ResourceState{}, false
	}
	return cloneResourceState(k.projection.ResourceState), true
}

// ResourceStateForLease returns the current durable resource authority only
// after validating the caller's live lease fence. Compute Fabric workers can
// bind admission/execution to this snapshot without granting the coordinator
// authority to relax local device policy.
func (k *Kernel) ResourceStateForLease(nodeID string, token LeaseToken) (ResourceState, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return ResourceState{}, err
	}
	if _, err := k.validateLeaseLocked(nodeID, token); err != nil {
		return ResourceState{}, err
	}
	if !k.projection.HasResourceState {
		return ResourceState{}, fmt.Errorf("%w: resource state", ErrNotFound)
	}
	return cloneResourceState(k.projection.ResourceState), nil
}
