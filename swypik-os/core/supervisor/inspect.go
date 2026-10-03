package supervisor

import (
	"fmt"
	"os"
	"path/filepath"

	"swypik-os/core/controlkernel"
)

// Inspect returns durable status without admitting a plan, opening read roots,
// compiling source, or changing journal contents. The caller supplies trusted
// task/run identities; the ledger must still match its Control Kernel owner.
func Inspect(kernel *controlkernel.Kernel, ledgerPath, taskID, runID string) (Snapshot, error) {
	if kernel == nil || !filepath.IsAbs(ledgerPath) || taskID == "" || runID == "" {
		return Snapshot{}, fmt.Errorf("supervisor inspection requires kernel, absolute ledger and task/run identities")
	}
	if info, err := os.Lstat(ledgerPath); err != nil {
		return Snapshot{}, err
	} else if !info.Mode().IsRegular() {
		return Snapshot{}, fmt.Errorf("supervisor ledger must be a regular file")
	}
	store, err := controlkernel.OpenExistingEventStore(ledgerPath)
	if err != nil {
		return Snapshot{}, err
	}
	defer store.Close()
	state := newLedgerState()
	for _, event := range store.Events() {
		if err := state.apply(event); err != nil {
			return Snapshot{}, fmt.Errorf("supervisor ledger replay: %w", err)
		}
	}
	if state.sequence == 0 {
		return Snapshot{}, fmt.Errorf("%w: supervisor ledger has no plan ownership", ErrRecoveryRequired)
	}
	task, exists := kernel.Task(taskID)
	if !exists {
		return Snapshot{}, fmt.Errorf("%w: supervisor ledger has no control-kernel task", ErrRecoveryRequired)
	}
	if state.created.TaskID != taskID || state.created.RunID != runID || task.Metadata["supervisor_plan_hash"] != state.created.PlanHash ||
		task.Metadata["supervisor_ledger_id"] != state.created.LedgerID || task.Metadata["supervisor_run_id"] != runID ||
		task.Budget.MaxReadBytes != state.created.MaxReadBytes {
		return Snapshot{}, ErrPolicyChanged
	}
	return state.status, nil
}
