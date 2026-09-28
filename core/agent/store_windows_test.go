//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestWindowsStoreRoundTripLockAndQuarantine(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agent")
	store, err := OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenFileStore(dir); err == nil {
		t.Fatal("second writer must be refused while the first holds the lock")
	}
	var calls atomic.Int32
	m, err := NewPersistent(recoveryPlanner(&calls, true), recoveryTools(&calls), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("inspect"); err != nil {
		t.Fatal(err)
	}
	waitRun(t, m, "awaiting_approval")
	m.Close()
	store.Close()

	// Restart: the pending approval is invalidated and the run is resumable.
	store, err = OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	m, err = NewPersistent(recoveryPlanner(&calls, true), recoveryTools(&calls), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	if r := m.Snapshot(); r == nil || r.Status != "interrupted" || r.Recovery != "replan" {
		t.Fatalf("recovered %+v", r)
	}
	m.Close()
	store.Close()

	// Corrupt checkpoint: quarantined, not fatal, original kept.
	os.WriteFile(filepath.Join(dir, checkpointName), []byte("{broken"), 0600)
	store, err = OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	m, err = NewPersistent(recoveryPlanner(&calls, true), recoveryTools(&calls), Limits{}, store)
	if err != nil || m.Snapshot() != nil {
		t.Fatalf("corrupt checkpoint: %v", err)
	}
	defer m.Close()
	if matches, _ := filepath.Glob(filepath.Join(dir, "invalid-run-*.json")); len(matches) != 1 {
		t.Fatal("quarantined checkpoint must be preserved")
	}
}
