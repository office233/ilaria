// Package agent provides a bounded, approval-gated agent runtime. Every tool
// call is shown to the user and runs only after an explicit approval. It is not
// a process sandbox: approved tools run with the user's permissions.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var ErrConflict = errors.New("run or approval is no longer current")

// MaxArgumentBytes bounds one tool call's JSON arguments (for example a file
// edit). Saved checkpoints must hold MaxSteps of them plus outputs.
const MaxArgumentBytes = 16 * 1024

var ErrClosed = errors.New("agent is stopped")
var ErrUncertain = errors.New("tool outcome is uncertain; automatic replay and resume are blocked")
var ErrPolicyChanged = errors.New("run limits changed; this run cannot be resumed")

// ErrInvalidCheckpoint marks a readable checkpoint whose content is corrupt or
// outside the supported envelope. Stores wrap it so startup can quarantine the
// file instead of refusing to start (a restart loop never repairs bad data).
var ErrInvalidCheckpoint = errors.New("invalid checkpoint")

// Quarantiner is implemented by stores that can set an invalid checkpoint aside
// for inspection. The file is renamed, never deleted.
type Quarantiner interface {
	Quarantine() (string, error)
}

// boundedText returns valid UTF-8 of at most limit bytes. Cutting a multi-byte
// rune would be re-encoded as U+FFFD by encoding/json and could grow the saved
// value past the limit that validateRun enforces on the next start.
func boundedText(s string, limit int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

type Spec struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Arguments   string `json:"arguments"`
}
type Tool struct {
	Spec     Spec
	Validate func(json.RawMessage) error
	Execute  func(context.Context, json.RawMessage) (json.RawMessage, error)
}
type Decision struct {
	Action    string          `json:"action"`
	Tool      string          `json:"tool,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	Summary   string          `json:"summary,omitempty"`
}
type Observation struct {
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Output    json.RawMessage `json:"output"`
}
type Planner interface {
	Next(context.Context, string, []Spec, []Observation) (Decision, error)
}
type Approval struct {
	ID        string          `json:"id"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
}
type Event struct {
	Sequence int       `json:"sequence"`
	Kind     string    `json:"kind"`
	Message  string    `json:"message"`
	At       time.Time `json:"at"`
}
type Run struct {
	ID             string    `json:"id"`
	Goal           string    `json:"goal"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
	Deadline       time.Time `json:"deadline"`
	Policy         Limits    `json:"policy"`
	AttemptedSteps int       `json:"attempted_steps"`
	Resumes        int       `json:"resumes"`
	// Recovery is replan only at a checkpoint with no unrecorded tool attempt.
	// uncertain means a tool might have executed; never replay it automatically.
	Recovery     string        `json:"recovery,omitempty"`
	Approval     *Approval     `json:"approval,omitempty"`
	Observations []Observation `json:"observations"`
	Events       []Event       `json:"events"`
	Summary      string        `json:"summary,omitempty"`
	Error        string        `json:"error,omitempty"`
}

// RunStatus is the lightweight polling projection of a run. It deliberately
// excludes Observations because tool arguments/outputs can be large and status
// UIs do not need to copy or transmit them on every refresh.
type RunStatus struct {
	ID             string    `json:"id"`
	Goal           string    `json:"goal,omitempty"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
	Deadline       time.Time `json:"deadline"`
	AttemptedSteps int       `json:"attempted_steps"`
	Resumes        int       `json:"resumes"`
	Recovery       string    `json:"recovery,omitempty"`
	Approval       *Approval `json:"approval,omitempty"`
	Events         []Event   `json:"events,omitempty"`
	Summary        string    `json:"summary,omitempty"`
	Error          string    `json:"error,omitempty"`
}
type Limits struct {
	MaxSteps       int           `json:"max_steps"`
	Duration       time.Duration `json:"duration"`
	ToolTimeout    time.Duration `json:"tool_timeout"`
	MaxOutputBytes int           `json:"max_output_bytes"`
}

// CheckpointStore must save atomically and report any durability failure.
// One Manager owns a store. The caller closes the store AFTER Manager.Close.
// OpenFileStore supplies Linux single-writer locking and private permissions.
type CheckpointStore interface {
	Load() (*Run, error)
	Save(Run) error
}
type DurableStore interface {
	CheckpointStore
	Close() error
}
type execution struct {
	run     Run
	ctx     context.Context
	cancel  context.CancelFunc
	answer  chan bool
	running bool
}
type Manager struct {
	mu         sync.Mutex
	planner    Planner
	tools      map[string]Tool
	specs      []Spec
	limits     Limits
	current    *execution
	closed     bool
	store      CheckpointStore
	storageErr error
}

func normalizedLimits(l Limits) (Limits, error) {
	if l.MaxSteps <= 0 {
		l.MaxSteps = 6
	}
	if l.Duration <= 0 {
		l.Duration = 5 * time.Minute
	}
	if l.ToolTimeout <= 0 {
		l.ToolTimeout = 10 * time.Second
	}
	if l.MaxOutputBytes <= 0 {
		l.MaxOutputBytes = 24 * 1024
	}
	if l.MaxSteps > 16 || l.Duration > time.Hour || l.ToolTimeout > time.Minute || l.MaxOutputBytes > 64*1024 {
		return l, fmt.Errorf("limits exceed the supported checkpoint envelope")
	}
	return l, nil
}
func New(planner Planner, tools []Tool, limits Limits) (*Manager, error) {
	if planner == nil {
		return nil, fmt.Errorf("planner is required")
	}
	limits, err := normalizedLimits(limits)
	if err != nil {
		return nil, err
	}
	m := &Manager{planner: planner, tools: map[string]Tool{}, limits: limits, specs: []Spec{}}
	for _, tool := range tools {
		if tool.Spec.Name == "" || len(tool.Spec.Name) > 128 || tool.Validate == nil || tool.Execute == nil {
			return nil, fmt.Errorf("invalid tool registration")
		}
		if _, ok := m.tools[tool.Spec.Name]; ok {
			return nil, fmt.Errorf("duplicate tool")
		}
		m.tools[tool.Spec.Name] = tool
		m.specs = append(m.specs, tool.Spec)
	}
	return m, nil
}

// NewPersistent loads only the last run. Recovery NEVER starts inference or tools.
// Pending approvals are invalidated, including after a clean service shutdown.
func NewPersistent(planner Planner, tools []Tool, limits Limits, store CheckpointStore) (*Manager, error) {
	if store == nil {
		return nil, fmt.Errorf("checkpoint store is required")
	}
	m, err := New(planner, tools, limits)
	if err != nil {
		return nil, err
	}
	m.store = store
	saved, err := store.Load()
	if err == nil && saved != nil {
		if verr := validateRun(*saved); verr != nil {
			err = fmt.Errorf("%w: %v", ErrInvalidCheckpoint, verr)
		}
	}
	if err != nil {
		q, ok := store.(Quarantiner)
		if !errors.Is(err, ErrInvalidCheckpoint) || !ok {
			return nil, err
		}
		if _, qerr := q.Quarantine(); qerr != nil {
			return nil, fmt.Errorf("%v; quarantine failed: %w", err, qerr)
		}
		return m, nil
	}
	if saved == nil {
		return m, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	e := &execution{run: copyRun(*saved), ctx: ctx, cancel: cancel}
	m.current = e
	if !terminal(e.run.Status) {
		next := copyRun(e.run)
		interruptRun(&next)
		if !time.Now().Before(next.Deadline) {
			next.Status = "failed"
			next.Recovery = ""
			next.Error = "Original run deadline expired."
		}
		addEvent(&next, "recovered", "Recovered checkpoint; no tool or inference was started.")
		if err := m.commitLocked(e, next); err != nil {
			return nil, err
		}
	}
	return m, nil
}
func randomID() (string, error) {
	var b [24]byte
	_, err := rand.Read(b[:])
	return hex.EncodeToString(b[:]), err
}
func terminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled" || status == "interrupted"
}
func (m *Manager) availableLocked() error {
	if m.storageErr != nil {
		return m.storageErr
	}
	if m.closed {
		return ErrClosed
	}
	return nil
}
func (m *Manager) Start(goal string) (Run, error) {
	goal = strings.TrimSpace(strings.ToValidUTF8(goal, "�"))
	if goal == "" || len(goal) > 4096 {
		return Run{}, fmt.Errorf("goal must contain 1-4096 bytes")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.availableLocked(); err != nil {
		return Run{}, err
	}
	if m.current != nil && (m.current.running || !terminal(m.current.run.Status)) {
		return Run{}, ErrConflict
	}
	id, err := randomID()
	if err != nil {
		return Run{}, err
	}
	now := time.Now().UTC()
	deadline := now.Add(m.limits.Duration)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	e := &execution{ctx: ctx, cancel: cancel, run: Run{ID: id, Goal: goal, Status: "planning", StartedAt: now, Deadline: deadline, Policy: m.limits, Events: []Event{}, Observations: []Observation{}}}
	m.current = e
	next := copyRun(e.run)
	addEvent(&next, "started", "Run started; every tool call requires approval.")
	if err := m.commitLocked(e, next); err != nil {
		cancel()
		return Run{}, err
	}
	e.running = true
	snapshot := copyRun(e.run)
	go m.execute(e)
	return snapshot, nil
}

// Resume requires explicit user consent in the session API. It preserves the
// original deadline and step/output budgets, and issues a NEW approval per tool.
func (m *Manager) Resume(runID string) (Run, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.availableLocked(); err != nil {
		return Run{}, err
	}
	old := m.current
	if old == nil || old.run.ID != runID || old.running || old.run.Status != "interrupted" {
		return Run{}, ErrConflict
	}
	if old.run.Recovery != "replan" {
		return Run{}, ErrUncertain
	}
	if old.run.Policy != m.limits {
		return Run{}, ErrPolicyChanged
	}
	if old.run.Resumes >= 8 {
		return Run{}, fmt.Errorf("resume limit reached")
	}
	if !time.Now().Before(old.run.Deadline) {
		return Run{}, fmt.Errorf("original run deadline expired")
	}
	next := copyRun(old.run)
	next.Status = "planning"
	next.Recovery = ""
	next.Error = ""
	next.Approval = nil
	next.Resumes++
	addEvent(&next, "resumed", "User resumed from recorded evidence; fresh approvals are required.")
	ctx, cancel := context.WithDeadline(context.Background(), next.Deadline)
	e := &execution{run: next, ctx: ctx, cancel: cancel}
	m.current = e
	if err := m.commitLocked(e, next); err != nil {
		cancel()
		return Run{}, err
	}
	e.running = true
	snapshot := copyRun(e.run)
	go m.execute(e)
	return snapshot, nil
}
func (m *Manager) Specs() []Spec { return append([]Spec(nil), m.specs...) }
func (m *Manager) Snapshot() *Run {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return nil
	}
	r := copyRun(m.current.run)
	return &r
}

func (m *Manager) StatusSnapshot() *RunStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return nil
	}
	r := &m.current.run
	status := &RunStatus{
		ID:             r.ID,
		Goal:           r.Goal,
		Status:         r.Status,
		StartedAt:      r.StartedAt,
		Deadline:       r.Deadline,
		AttemptedSteps: r.AttemptedSteps,
		Resumes:        r.Resumes,
		Recovery:       r.Recovery,
		Summary:        r.Summary,
		Error:          r.Error,
	}
	if r.Approval != nil {
		a := *r.Approval
		a.Arguments = append(json.RawMessage(nil), a.Arguments...)
		status.Approval = &a
	}
	const maxStatusEvents = 32
	start := 0
	if len(r.Events) > maxStatusEvents {
		start = len(r.Events) - maxStatusEvents
	}
	status.Events = append([]Event(nil), r.Events[start:]...)
	return status
}
func cloneObservations(in []Observation) []Observation {
	out := append([]Observation{}, in...)
	for i := range out {
		out[i].Arguments = append(json.RawMessage(nil), out[i].Arguments...)
		out[i].Output = append(json.RawMessage(nil), out[i].Output...)
	}
	return out
}
func copyRun(r Run) Run {
	r.Events = append([]Event{}, r.Events...)
	r.Observations = cloneObservations(r.Observations)
	if r.Approval != nil {
		a := *r.Approval
		a.Arguments = append(json.RawMessage(nil), a.Arguments...)
		r.Approval = &a
	}
	return r
}

// Decide writes the consumed approval BEFORE releasing the execution gate.
// A crash between this checkpoint and the result is uncertain, not retryable.
func (m *Manager) Decide(runID, approvalID string, approve bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.availableLocked(); err != nil {
		return err
	}
	e := m.current
	if e == nil || e.run.ID != runID || e.ctx.Err() != nil || e.run.Status != "awaiting_approval" || e.run.Approval == nil || e.run.Approval.ID != approvalID {
		return ErrConflict
	}
	next := copyRun(e.run)
	tool := next.Approval.Tool
	next.Approval = nil
	if approve {
		next.Status = "executing"
		next.AttemptedSteps++
		addEvent(&next, "approved", tool)
	} else {
		next.Status = "cancelled"
		addEvent(&next, "denied", "Tool denied by user.")
	}
	if err := m.commitLocked(e, next); err != nil {
		return err
	}
	if !approve {
		e.cancel()
	}
	e.answer <- approve
	return nil
}
func (m *Manager) Cancel(runID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.availableLocked(); err != nil {
		return err
	}
	e := m.current
	if e == nil || e.run.ID != runID {
		return ErrConflict
	}
	if !terminal(e.run.Status) || e.run.Status == "interrupted" {
		next := copyRun(e.run)
		next.Status = "cancelled"
		next.Approval = nil
		next.Recovery = ""
		addEvent(&next, "cancelled", "Cancelled by user; completed external effects are not undone.")
		err := m.commitLocked(e, next)
		e.cancel()
		return err
	}
	return nil
}
func interruptRun(r *Run) {
	r.Recovery = "replan"
	if r.Status == "executing" || r.AttemptedSteps != len(r.Observations) {
		r.Recovery = "uncertain"
	}
	r.Status = "interrupted"
	r.Approval = nil
	r.Error = "Service stopped. Explicit resume and fresh approvals are required."
	if r.Recovery == "uncertain" {
		r.Error = "A tool may have executed without a recorded result. Automatic replay and resume are blocked."
	}
}

// Close prevents later callbacks from saving into a released store. It cancels
// cooperative workers; it does NOT claim to forcibly terminate arbitrary code.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	if e := m.current; e != nil {
		if !terminal(e.run.Status) && m.storageErr == nil {
			next := copyRun(e.run)
			interruptRun(&next)
			addEvent(&next, "interrupted", "Service shutdown; approval invalidated.")
			_ = m.commitLocked(e, next)
		}
		e.cancel()
	}
	m.closed = true
}
func addEvent(r *Run, kind, message string) {
	r.Events = append(r.Events, Event{Sequence: len(r.Events) + 1, Kind: kind, Message: boundedText(message, 2048), At: time.Now().UTC()})
}

// Caller holds m.mu. A save error latches the manager closed to further work;
// never continue executing with a checkpoint that may not be durable.
func (m *Manager) commitLocked(e *execution, next Run) error {
	if m.store != nil {
		if err := m.store.Save(copyRun(next)); err != nil {
			m.storageErr = fmt.Errorf("agent checkpoint failed: %w", err)
			e.run.Status = "failed"
			e.run.Approval = nil
			e.run.Error = "State storage failed. Further actions are blocked until service restart."
			e.cancel()
			return m.storageErr
		}
	}
	e.run = next
	return nil
}
func (m *Manager) activeLocked(e *execution) bool {
	return !m.closed && m.storageErr == nil && m.current == e && !terminal(e.run.Status)
}
func (m *Manager) fail(e *execution, err error) {
	if err == nil {
		err = context.Canceled
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.activeLocked(e) {
		return
	}
	next := copyRun(e.run)
	next.Status = "failed"
	if errors.Is(err, context.Canceled) {
		next.Status = "cancelled"
	}
	message := boundedText(err.Error(), 2048)
	next.Error = message
	next.Approval = nil
	addEvent(&next, next.Status, message)
	_ = m.commitLocked(e, next)
}
func (m *Manager) execute(e *execution) {
	defer func() {
		if recover() != nil {
			m.fail(e, fmt.Errorf("planner or tool panicked; run stopped"))
		}
		e.cancel()
		m.mu.Lock()
		e.running = false
		m.mu.Unlock()
	}()
	m.mu.Lock()
	goal := e.run.Goal
	observations := cloneObservations(e.run.Observations)
	attempted := e.run.AttemptedSteps
	m.mu.Unlock()
	used := 0
	for _, o := range observations {
		used += len(o.Output)
	}
	for {
		if err := e.ctx.Err(); err != nil {
			m.fail(e, err)
			return
		}
		decision, err := m.planner.Next(e.ctx, goal, m.Specs(), cloneObservations(observations))
		if err == nil {
			err = e.ctx.Err()
		}
		if err != nil {
			m.fail(e, err)
			return
		}
		if decision.Action == "finish" {
			decision.Summary = strings.ToValidUTF8(decision.Summary, "�")
			if strings.TrimSpace(decision.Summary) == "" || len(decision.Summary) > 8192 || decision.Tool != "" || len(decision.Arguments) != 0 {
				m.fail(e, fmt.Errorf("invalid final decision"))
				return
			}
			m.mu.Lock()
			if m.activeLocked(e) {
				next := copyRun(e.run)
				next.Status = "completed"
				next.Summary = decision.Summary
				addEvent(&next, "completed", "Ilaria returned a summary; inspect the recorded tool evidence.")
				_ = m.commitLocked(e, next)
			}
			m.mu.Unlock()
			return
		}
		tool, exists := m.tools[decision.Tool]
		if decision.Action != "tool" || !exists || decision.Summary != "" {
			m.fail(e, fmt.Errorf("planner requested an unavailable action"))
			return
		}
		if attempted >= m.limits.MaxSteps {
			m.fail(e, fmt.Errorf("tool step limit reached"))
			return
		}
		args := append(json.RawMessage(nil), decision.Arguments...)
		if len(args) == 0 || string(args) == "null" {
			// Models commonly omit arguments for zero-argument tools.
			args = json.RawMessage("{}")
		}
		if len(args) > MaxArgumentBytes || !json.Valid(args) {
			m.fail(e, fmt.Errorf("invalid tool arguments"))
			return
		}
		if err := tool.Validate(append(json.RawMessage(nil), args...)); err != nil {
			m.fail(e, fmt.Errorf("invalid arguments for %s: %w", decision.Tool, err))
			return
		}
		id, err := randomID()
		if err != nil {
			m.fail(e, err)
			return
		}
		m.mu.Lock()
		if !m.activeLocked(e) || e.ctx.Err() != nil {
			m.mu.Unlock()
			m.fail(e, e.ctx.Err())
			return
		}
		answer := make(chan bool, 1)
		e.answer = answer
		next := copyRun(e.run)
		next.Approval = &Approval{ID: id, Tool: decision.Tool, Arguments: append(json.RawMessage(nil), args...)}
		next.Status = "awaiting_approval"
		addEvent(&next, "approval_required", decision.Tool)
		err = m.commitLocked(e, next)
		m.mu.Unlock()
		if err != nil {
			return
		}
		select {
		case accepted := <-answer:
			if !accepted {
				return
			}
		case <-e.ctx.Done():
			m.fail(e, e.ctx.Err())
			return
		}
		if err := e.ctx.Err(); err != nil {
			m.fail(e, err)
			return
		}
		attempted++
		ctx, cancel := context.WithTimeout(e.ctx, m.limits.ToolTimeout)
		output, err := tool.Execute(ctx, append(json.RawMessage(nil), args...))
		if err == nil {
			err = ctx.Err()
		}
		cancel()
		if err != nil {
			m.fail(e, fmt.Errorf("%s: %w", decision.Tool, err))
			return
		}
		if !json.Valid(output) || len(output) > 12*1024 || used+len(output) > m.limits.MaxOutputBytes {
			m.fail(e, fmt.Errorf("tool output invalid or exceeds context budget"))
			return
		}
		used += len(output)
		observation := Observation{Tool: decision.Tool, Arguments: append(json.RawMessage(nil), args...), Output: append(json.RawMessage(nil), output...)}
		observations = append(observations, observation)
		m.mu.Lock()
		if !m.activeLocked(e) {
			m.mu.Unlock()
			return
		}
		next = copyRun(e.run)
		next.Observations = cloneObservations(observations)
		next.Status = "planning"
		addEvent(&next, "tool_completed", decision.Tool)
		err = m.commitLocked(e, next)
		m.mu.Unlock()
		if err != nil {
			return
		}
	}
}

// validateRun bounds untrusted disk data before exposing it to the planner.
func validateRun(r Run) error {
	id, err := hex.DecodeString(r.ID)
	if err != nil || len(id) != 24 {
		return fmt.Errorf("invalid run id")
	}
	l, err := normalizedLimits(r.Policy)
	if err != nil || l != r.Policy {
		return fmt.Errorf("invalid saved limits")
	}
	if strings.TrimSpace(r.Goal) == "" || len(r.Goal) > 4096 || r.StartedAt.IsZero() || !r.Deadline.Equal(r.StartedAt.Add(r.Policy.Duration)) {
		return fmt.Errorf("invalid goal or deadline")
	}
	switch r.Status {
	case "planning", "awaiting_approval", "executing", "completed", "failed", "cancelled", "interrupted":
	default:
		return fmt.Errorf("invalid run status")
	}
	if r.Resumes < 0 || r.Resumes > 8 || len(r.Events) > 128 || len(r.Summary) > 8192 || len(r.Error) > 2048 || r.AttemptedSteps < len(r.Observations) || r.AttemptedSteps > r.Policy.MaxSteps || r.AttemptedSteps-len(r.Observations) > 1 {
		return fmt.Errorf("saved run exceeds limits")
	}
	if r.Recovery != "" && (r.Status != "interrupted" || (r.Recovery != "replan" && r.Recovery != "uncertain")) {
		return fmt.Errorf("invalid recovery state")
	}
	if r.Status == "interrupted" && r.Recovery == "" {
		return fmt.Errorf("missing recovery state")
	}
	if r.Recovery == "replan" && r.AttemptedSteps != len(r.Observations) {
		return fmt.Errorf("unrecorded attempt cannot resume")
	}
	if (r.Status == "planning" || r.Status == "awaiting_approval" || r.Status == "completed") && r.AttemptedSteps != len(r.Observations) {
		return fmt.Errorf("missing tool evidence")
	}
	if (r.Status == "awaiting_approval") != (r.Approval != nil) {
		return fmt.Errorf("invalid saved approval state")
	}
	if r.Approval != nil {
		a := r.Approval
		id, err := hex.DecodeString(a.ID)
		if err != nil || len(id) != 24 || a.Tool == "" || len(a.Tool) > 128 || len(a.Arguments) > MaxArgumentBytes || !json.Valid(a.Arguments) {
			return fmt.Errorf("invalid saved approval")
		}
	}
	used := 0
	for _, o := range r.Observations {
		if o.Tool == "" || len(o.Tool) > 128 || len(o.Arguments) > MaxArgumentBytes || !json.Valid(o.Arguments) || len(o.Output) > 12*1024 || !json.Valid(o.Output) {
			return fmt.Errorf("invalid saved observation")
		}
		used += len(o.Output)
	}
	if used > r.Policy.MaxOutputBytes {
		return fmt.Errorf("saved output budget exceeded")
	}
	for i, e := range r.Events {
		if e.Sequence != i+1 || len(e.Kind) > 64 || len(e.Message) > 2048 || e.At.IsZero() {
			return fmt.Errorf("invalid saved event")
		}
	}
	return nil
}
