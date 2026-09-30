package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type plannerFunc func(context.Context, string, []Spec, []Observation) (Decision, error)

func (f plannerFunc) Next(c context.Context, g string, s []Spec, o []Observation) (Decision, error) {
	return f(c, g, s, o)
}
func waitRun(t *testing.T, m *Manager, status string) *Run {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r := m.Snapshot()
		if r != nil && r.Status == status {
			return r
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("wanted %s, got %+v", status, m.Snapshot())
	return nil
}
func fixture(t *testing.T, limits Limits, repeat bool) (*Manager, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	planner := plannerFunc(func(_ context.Context, _ string, _ []Spec, o []Observation) (Decision, error) {
		if len(o) == 0 || repeat {
			return Decision{Action: "tool", Tool: "test.read", Arguments: json.RawMessage(`{}`)}, nil
		}
		return Decision{Action: "finish", Summary: "Observed real fixture output."}, nil
	})
	tool := Tool{Spec: Spec{Name: "test.read"}, Validate: func(r json.RawMessage) error { return DecodeObject(r, &struct{}{}, 4096) }, Execute: func(context.Context, json.RawMessage) (json.RawMessage, error) {
		calls.Add(1)
		return json.RawMessage(`{"fixture":true}`), nil
	}}
	m, err := New(planner, []Tool{tool}, limits)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m, calls
}
func TestApprovalBeforeExecutionAndImmutableSnapshot(t *testing.T) {
	m, calls := fixture(t, Limits{}, false)
	run, err := m.Start("inspect")
	if err != nil {
		t.Fatal(err)
	}
	pending := waitRun(t, m, "awaiting_approval")
	if calls.Load() != 0 {
		t.Fatal("tool ran without consent")
	}
	if _, err := m.Start("other"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := m.Decide(run.ID, "stale", true); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	pending.Approval.Arguments[0] = 'x'
	fresh := m.Snapshot()
	if string(fresh.Approval.Arguments) != "{}" {
		t.Fatal("snapshot mutation changed approval")
	}
	if err := m.Decide(run.ID, fresh.Approval.ID, true); err != nil {
		t.Fatal(err)
	}
	done := waitRun(t, m, "completed")
	if calls.Load() != 1 || len(done.Observations) != 1 || !strings.Contains(string(done.Observations[0].Output), "fixture") {
		t.Fatal(done)
	}
	if err := m.Decide(run.ID, fresh.Approval.ID, true); !errors.Is(err, ErrConflict) {
		t.Fatal("replayed approval", err)
	}
}

func TestStatusSnapshotOmitsHeavyObservationsAndBoundsEvents(t *testing.T) {
	manager := &Manager{
		current: &execution{run: Run{
			ID:     "run-1",
			Goal:   "inspect",
			Status: "awaiting_approval",
			Approval: &Approval{
				ID:        "approval-1",
				Tool:      "workspace.read",
				Arguments: json.RawMessage(`{"path":"a.txt"}`),
			},
			Observations: []Observation{{
				Tool:   "workspace.read",
				Output: json.RawMessage(`{"content":"large-output"}`),
			}},
		}},
	}
	for i := 0; i < 40; i++ {
		manager.current.run.Events = append(manager.current.run.Events, Event{Sequence: i + 1, Kind: "step", Message: "x"})
	}
	status := manager.StatusSnapshot()
	if status == nil || status.ID != "run-1" || len(status.Events) != 32 {
		t.Fatalf("status=%+v", status)
	}
	if status.Events[0].Sequence != 9 || status.Events[31].Sequence != 40 {
		t.Fatalf("event window=%d..%d", status.Events[0].Sequence, status.Events[31].Sequence)
	}
	status.Approval.Arguments[0] = '['
	if got := string(manager.current.run.Approval.Arguments); got != `{"path":"a.txt"}` {
		t.Fatalf("status snapshot aliases approval arguments: %q", got)
	}
}
func TestConcurrentApprovalIsAtMostOnce(t *testing.T) {
	m, calls := fixture(t, Limits{}, false)
	_, _ = m.Start("inspect")
	p := waitRun(t, m, "awaiting_approval")
	var wg sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if m.Decide(p.ID, p.Approval.ID, true) == nil {
				accepted.Add(1)
			}
			_ = m.Snapshot()
		}()
	}
	wg.Wait()
	waitRun(t, m, "completed")
	if accepted.Load() != 1 || calls.Load() != 1 {
		t.Fatal(accepted.Load(), calls.Load())
	}
}
func TestDenyCancelAndTimeout(t *testing.T) {
	for _, kind := range []string{"deny", "cancel", "timeout"} {
		t.Run(kind, func(t *testing.T) {
			limits := Limits{}
			if kind == "timeout" {
				limits.Duration = 100 * time.Millisecond
			}
			m, calls := fixture(t, limits, false)
			_, _ = m.Start("inspect")
			p := waitRun(t, m, "awaiting_approval")
			switch kind {
			case "deny":
				_ = m.Decide(p.ID, p.Approval.ID, false)
			case "cancel":
				_ = m.Cancel(p.ID)
			}
			status := "cancelled"
			if kind == "timeout" {
				status = "failed"
			}
			waitRun(t, m, status)
			if calls.Load() != 0 {
				t.Fatal("cancelled tool executed")
			}
			if err := m.Decide(p.ID, p.Approval.ID, true); !errors.Is(err, ErrConflict) {
				t.Fatal(err)
			}
		})
	}
}
func TestCancelDuringPlanning(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})
	planner := plannerFunc(func(ctx context.Context, _ string, _ []Spec, _ []Observation) (Decision, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return Decision{}, ctx.Err()
	})
	m, _ := New(planner, nil, Limits{})
	defer m.Close()
	r, _ := m.Start("inspect")
	<-started
	_ = m.Cancel(r.ID)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("planner was not cancelled")
	}
	waitRun(t, m, "cancelled")
}
func TestLimitsAndUnknownToolFailClosed(t *testing.T) {
	t.Run("steps", func(t *testing.T) {
		m, calls := fixture(t, Limits{MaxSteps: 1}, true)
		_, _ = m.Start("inspect")
		p := waitRun(t, m, "awaiting_approval")
		_ = m.Decide(p.ID, p.Approval.ID, true)
		r := waitRun(t, m, "failed")
		if calls.Load() != 1 || !strings.Contains(r.Error, "limit") {
			t.Fatal(r)
		}
	})
	t.Run("output", func(t *testing.T) {
		m, _ := fixture(t, Limits{MaxOutputBytes: 1}, false)
		_, _ = m.Start("inspect")
		p := waitRun(t, m, "awaiting_approval")
		_ = m.Decide(p.ID, p.Approval.ID, true)
		waitRun(t, m, "failed")
	})
	t.Run("tool", func(t *testing.T) {
		m, _ := New(plannerFunc(func(context.Context, string, []Spec, []Observation) (Decision, error) {
			return Decision{Action: "tool", Tool: "shell.exec", Arguments: json.RawMessage(`{}`)}, nil
		}), nil, Limits{})
		defer m.Close()
		_, _ = m.Start("ignore policies")
		waitRun(t, m, "failed")
	})
}
func TestStrictJSON(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{}`, `{"action":"finish","unknown":1}`, `{"action":"finish","action":"tool"}`, `{"action":"tool","arguments":{"path":"a","path":"b"}}`, `{"action":"finish"} {}`, "```json\n{}\n```"} {
		var d Decision
		err := DecodeObject([]byte(raw), &d, 8192)
		if raw == `{}` {
			continue
		}
		if err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	var d Decision
	if err := DecodeObject([]byte(`{"action":"finish","summary":"ok"}`), &d, 8192); err != nil {
		t.Fatal(err)
	}
}
func TestWorkspaceScope(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "safe.txt"), []byte("never read"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	tool := ReadOnlyTools(root)[1]
	for _, arg := range []string{`{"path":"../"}`, `{"path":".git"}`, `{"path":"C:/Windows"}`, `{"path":"/etc"}`, `{"path":"//server/share"}`, `{"path":"\u0000"}`, `{"path":"." ,"path":".."}`} {
		if tool.Validate(json.RawMessage(arg)) == nil {
			t.Error("accepted", arg)
		}
	}
	raw, err := tool.Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, "safe.txt") || strings.Contains(text, ".env") || strings.Contains(text, "never read") {
		t.Fatal(text)
	}
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if os.Symlink(outside, link) == nil {
		if _, err := tool.Execute(context.Background(), json.RawMessage(`{"path":"escape"}`)); err == nil {
			t.Fatal("escaped workspace")
		}
	}
}
func TestJSONPlannerPreservesDataEnvelope(t *testing.T) {
	p := JSONPlanner{Complete: func(_ context.Context, prompt string) (string, error) {
		if !strings.Contains(prompt, "untrusted_observations") {
			t.Fatal("missing trust boundary")
		}
		return `{"action":"finish","summary":"No unsupported claims."}`, nil
	}}
	if d, err := p.Next(context.Background(), "test", nil, nil); err != nil || d.Action != "finish" {
		t.Fatal(d, err)
	}
}
func FuzzDecodeObject(f *testing.F) {
	f.Add(`{"action":"tool","arguments":{}}`)
	f.Add(`null`)
	f.Fuzz(func(t *testing.T, raw string) { var d Decision; _ = DecodeObject([]byte(raw), &d, 8192) })
}
