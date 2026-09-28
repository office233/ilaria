package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memoryCheckpoint struct {
	mu         sync.Mutex
	last       *Run
	failStatus string
}

func (s *memoryCheckpoint) Load() (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil {
		return nil, nil
	}
	r := copyRun(*s.last)
	return &r, nil
}
func (s *memoryCheckpoint) Save(r Run) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Status == s.failStatus {
		return fmt.Errorf("injected checkpoint failure")
	}
	if err := validateRun(r); err != nil {
		return err
	}
	copy := copyRun(r)
	s.last = &copy
	return nil
}
func recoveryTools(calls *atomic.Int32) []Tool {
	return []Tool{{Spec: Spec{Name: "test.read"}, Validate: func(r json.RawMessage) error { return DecodeObject(r, &struct{}{}, 4096) }, Execute: func(context.Context, json.RawMessage) (json.RawMessage, error) {
		calls.Add(1)
		return json.RawMessage(`{"actual":true}`), nil
	}}}
}
func recoveryPlanner(calls *atomic.Int32, repeat bool) Planner {
	return plannerFunc(func(_ context.Context, _ string, _ []Spec, o []Observation) (Decision, error) {
		calls.Add(1)
		if len(o) == 0 || repeat {
			return Decision{Action: "tool", Tool: "test.read", Arguments: json.RawMessage(`{}`)}, nil
		}
		return Decision{Action: "finish", Summary: "Recorded evidence retained."}, nil
	})
}
func pendingSavedRun(t *testing.T) Run {
	t.Helper()
	m, _ := fixture(t, Limits{}, false)
	if _, err := m.Start("inspect"); err != nil {
		t.Fatal(err)
	}
	r := copyRun(*waitRun(t, m, "awaiting_approval"))
	m.Close()
	return r
}
func TestPersistentRecoveryRequiresConsentAndNewApproval(t *testing.T) {
	store := &memoryCheckpoint{}
	var plans, tools atomic.Int32
	m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Start("inspect"); err != nil {
		t.Fatal(err)
	}
	p := waitRun(t, m, "awaiting_approval")
	m.Close()
	n, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	r := n.Snapshot()
	if r.Status != "interrupted" || r.Approval != nil || r.Recovery != "replan" || plans.Load() != 1 || tools.Load() != 0 {
		t.Fatal(r, plans.Load(), tools.Load())
	}
	if err := n.Decide(p.ID, p.Approval.ID, true); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := n.Resume(p.ID); err != nil {
		t.Fatal(err)
	}
	fresh := waitRun(t, n, "awaiting_approval")
	if fresh.Approval.ID == p.Approval.ID || !fresh.Deadline.Equal(p.Deadline) || fresh.Resumes != 1 {
		t.Fatal(fresh)
	}
	if err := n.Decide(fresh.ID, fresh.Approval.ID, true); err != nil {
		t.Fatal(err)
	}
	done := waitRun(t, n, "completed")
	if tools.Load() != 1 || len(done.Observations) != 1 || done.AttemptedSteps != 1 {
		t.Fatal(done)
	}
	n.Close()
	again, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if again.Snapshot().Status != "completed" || tools.Load() != 1 {
		t.Fatal("completed run replayed")
	}
}
func TestCrashAfterConsumptionCannotReplayTool(t *testing.T) {
	r := pendingSavedRun(t)
	r.Status = "executing"
	r.Approval = nil
	r.AttemptedSteps = 1
	store := &memoryCheckpoint{}
	if err := store.Save(r); err != nil {
		t.Fatal(err)
	}
	var plans, tools atomic.Int32
	m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	recovered := m.Snapshot()
	if recovered.Status != "interrupted" || recovered.Recovery != "uncertain" {
		t.Fatal(recovered)
	}
	if _, err := m.Resume(r.ID); !errors.Is(err, ErrUncertain) {
		t.Fatal(err)
	}
	if tools.Load() != 0 || plans.Load() != 0 {
		t.Fatal("recovery executed work")
	}
}
func TestCheckpointFailureBlocksApprovedExecution(t *testing.T) {
	store := &memoryCheckpoint{failStatus: "executing"}
	var plans, tools atomic.Int32
	m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	_, _ = m.Start("inspect")
	p := waitRun(t, m, "awaiting_approval")
	if err := m.Decide(p.ID, p.Approval.ID, true); err == nil {
		t.Fatal("acknowledged undurable approval")
	}
	if _, err := m.Start("try again"); err == nil {
		t.Fatal("storage failure did not latch")
	}
	if tools.Load() != 0 {
		t.Fatal("tool executed before durable approval")
	}
	saved, _ := store.Load()
	if saved.Status != "awaiting_approval" {
		t.Fatal(saved)
	}
}
func TestCheckpointFailurePreventsPlanning(t *testing.T) {
	store := &memoryCheckpoint{failStatus: "planning"}
	var plans, tools atomic.Int32
	m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, err := m.Start("inspect"); err == nil {
		t.Fatal("accepted start without checkpoint")
	}
	if plans.Load() != 0 || tools.Load() != 0 {
		t.Fatal("started undurable run")
	}
}
func TestCrashRecoveryPreservesEvidenceAndLimits(t *testing.T) {
	r := pendingSavedRun(t)
	r.Status = "planning"
	r.Approval = nil
	r.Policy.MaxSteps = 1
	r.AttemptedSteps = 1
	r.Observations = []Observation{{Tool: "test.read", Arguments: json.RawMessage(`{}`), Output: json.RawMessage(`{"actual":true}`)}}
	store := &memoryCheckpoint{}
	if err := store.Save(r); err != nil {
		t.Fatal(err)
	}
	var plans, tools atomic.Int32
	m, err := NewPersistent(recoveryPlanner(&plans, true), recoveryTools(&tools), Limits{MaxSteps: 1}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, err := m.Resume(r.ID); err != nil {
		t.Fatal(err)
	}
	done := waitRun(t, m, "failed")
	if done.AttemptedSteps != 1 || len(done.Observations) != 1 || tools.Load() != 0 || !done.Deadline.Equal(r.Deadline) {
		t.Fatal(done)
	}
}
func TestRecoveryRejectsExpiredDeadlineAndChangedPolicy(t *testing.T) {
	t.Run("expired", func(t *testing.T) {
		r := pendingSavedRun(t)
		r.StartedAt = time.Now().UTC().Add(-time.Hour)
		r.Deadline = r.StartedAt.Add(r.Policy.Duration)
		store := &memoryCheckpoint{}
		_ = store.Save(r)
		var plans, tools atomic.Int32
		m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, store)
		if err != nil {
			t.Fatal(err)
		}
		defer m.Close()
		if m.Snapshot().Status != "failed" || plans.Load() != 0 {
			t.Fatal(m.Snapshot())
		}
	})
	t.Run("policy", func(t *testing.T) {
		r := pendingSavedRun(t)
		store := &memoryCheckpoint{}
		_ = store.Save(r)
		var plans, tools atomic.Int32
		m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{MaxSteps: 1}, store)
		if err != nil {
			t.Fatal(err)
		}
		defer m.Close()
		if _, err := m.Resume(r.ID); !errors.Is(err, ErrPolicyChanged) {
			t.Fatal(err)
		}
	})
}
func TestPlannerCannotMutateRecordedEvidence(t *testing.T) {
	store := &memoryCheckpoint{}
	var calls atomic.Int32
	planner := plannerFunc(func(_ context.Context, _ string, _ []Spec, o []Observation) (Decision, error) {
		if len(o) == 0 {
			return Decision{Action: "tool", Tool: "test.read", Arguments: json.RawMessage(`{}`)}, nil
		}
		o[0].Output[0] = 'x'
		o[0].Arguments[0] = 'x'
		return Decision{Action: "finish", Summary: "done"}, nil
	})
	m, err := NewPersistent(planner, recoveryTools(&calls), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	_, _ = m.Start("inspect")
	p := waitRun(t, m, "awaiting_approval")
	if err := m.Decide(p.ID, p.Approval.ID, true); err != nil {
		t.Fatal(err)
	}
	r := waitRun(t, m, "completed")
	if !json.Valid(r.Observations[0].Output) || string(r.Observations[0].Arguments) != "{}" {
		t.Fatal("planner mutated evidence")
	}
}
func TestClosePreventsLateCheckpointWrites(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	planner := plannerFunc(func(context.Context, string, []Spec, []Observation) (Decision, error) {
		close(started)
		<-release
		close(finished)
		return Decision{Action: "finish", Summary: "late"}, nil
	})
	store := &memoryCheckpoint{}
	m, err := NewPersistent(planner, nil, Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = m.Start("inspect")
	<-started
	m.Close()
	close(release)
	<-finished
	saved, _ := store.Load()
	if saved.Status != "interrupted" {
		t.Fatal(saved)
	}
	if _, err := m.Start("new"); !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
}
func TestPanickingToolFailsRun(t *testing.T) {
	var plans, calls atomic.Int32
	tools := recoveryTools(&calls)
	tools[0].Execute = func(context.Context, json.RawMessage) (json.RawMessage, error) { panic("fixture") }
	m, err := New(recoveryPlanner(&plans, false), tools, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	_, _ = m.Start("inspect")
	p := waitRun(t, m, "awaiting_approval")
	_ = m.Decide(p.ID, p.Approval.ID, true)
	waitRun(t, m, "failed")
}
