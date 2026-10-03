package controlkernel

import (
	"errors"
	"testing"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

func testResourceState() ResourceState {
	return ResourceState{
		Profile:                  "balanced",
		BaseBackgroundCPUPercent: 8,
		BaseBackgroundGPUPercent: 20,
		BaseBackgroundWorkers:    2,
		MaxBackgroundCPUPercent:  2,
		MaxBackgroundGPUPercent:  5,
		MaxBackgroundWorkers:     1,
		Preempt:                  true,
		Reasons:                  []string{"foreground-active"},
	}
}

func TestResourceStateIsKernelVersionedBoundedAndReplayable(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 30, 7, 30, 0, 0, time.UTC)}
	kernel, path := openTestKernel(t, clock)
	state := testResourceState()
	first, err := kernel.RecordResourceState(state)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || first.ObservedAtUnixMS != clock.Now().UnixMilli() {
		t.Fatalf("first authority metadata=%+v", first)
	}
	state.Reasons[0] = "mutated-by-caller"
	stored, ok := kernel.CurrentResourceState()
	if !ok || stored.Reasons[0] != "foreground-active" {
		t.Fatalf("projection aliased caller state: %+v", stored)
	}

	invalid := testResourceState()
	invalid.MaxBackgroundCPUPercent = invalid.BaseBackgroundCPUPercent + 1
	if _, err := kernel.RecordResourceState(invalid); err == nil {
		t.Fatal("resource state above base envelope was accepted")
	}
	if stored, _ := kernel.CurrentResourceState(); stored.Revision != 1 {
		t.Fatalf("rejected state advanced projection: %+v", stored)
	}

	clock.Add(time.Second)
	second := testResourceState()
	second.MaxBackgroundCPUPercent = second.BaseBackgroundCPUPercent
	second.MaxBackgroundGPUPercent = second.BaseBackgroundGPUPercent
	second.MaxBackgroundWorkers = second.BaseBackgroundWorkers
	second.Preempt = false
	second.Reasons = nil
	persisted, err := kernel.RecordResourceState(second)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Revision != 2 {
		t.Fatalf("revision=%d want 2", persisted.Revision)
	}
	if err := kernel.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenKernel(path, WithClock(clock.Now))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	replayed, ok := reopened.CurrentResourceState()
	if !ok || replayed.Revision != 2 || replayed.Preempt || replayed.MaxBackgroundWorkers != 2 {
		t.Fatalf("replayed state=%+v ok=%v", replayed, ok)
	}
}

func TestGovernorTransitionsPersistThroughControlKernelSink(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 30, 7, 45, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()

	governor := resourcepolicy.NewGovernor(resourcepolicy.ForProfile(resourcepolicy.ProfileBalanced))
	if err := governor.SetTransitionSink(NewResourceTransitionSink(kernel)); err != nil {
		t.Fatal(err)
	}
	initial, ok := kernel.CurrentResourceState()
	if !ok || initial.Revision != 1 || initial.MaxBackgroundCPUPercent != 8 || initial.Preempt {
		t.Fatalf("initial durable resource state=%+v ok=%v", initial, ok)
	}

	clock.Add(time.Second)
	governor.UpdateSignals(resourcepolicy.RuntimeSignals{UserActive: true, BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	foreground, ok := kernel.CurrentResourceState()
	if !ok || foreground.Revision != 2 || !foreground.Preempt || foreground.MaxBackgroundCPUPercent != 2 || foreground.MaxBackgroundGPUPercent != 5 || len(foreground.Reasons) != 1 || foreground.Reasons[0] != "foreground-active" {
		t.Fatalf("foreground durable resource state=%+v ok=%v", foreground, ok)
	}

	// Repeating identical pressure must not inflate the durable journal revision.
	governor.UpdateSignals(resourcepolicy.RuntimeSignals{UserActive: true, BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	unchanged, _ := kernel.CurrentResourceState()
	if unchanged.Revision != 2 {
		t.Fatalf("unchanged pressure advanced revision to %d", unchanged.Revision)
	}
}

func TestResourceStateIsAvailableThroughCurrentLeaseFence(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	if _, err := kernel.RecordResourceState(testResourceState()); err != nil {
		t.Fatal(err)
	}
	createReadyNode(t, kernel, "compute-task", "training-node")
	lease, err := kernel.ClaimLease("training-node", "executor-credential", "compute-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	state, err := kernel.ResourceStateForLease("training-node", token)
	if err != nil {
		t.Fatal(err)
	}
	if state.Revision != 1 || state.Profile != "balanced" || !state.Preempt {
		t.Fatalf("lease resource state=%+v", state)
	}
	if _, err := kernel.ResourceStateForLease("training-node", LeaseToken{LeaseID: lease.ID, Fence: lease.Fence + 1}); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("stale fence resource state err=%v want ErrStaleLease", err)
	}
}
