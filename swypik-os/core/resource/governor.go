package resource

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Governor cooperatively bounds background parallelism and duty cycle.
//
// It is intentionally simple: foreground work never waits on the governor;
// only code that explicitly opts into background execution uses it. Long
// compute kernels must still observe ctx internally so cancellation can preempt
// them promptly.
type Governor struct {
	transitionMu  sync.Mutex
	mu            sync.Mutex
	base          Policy
	budget        BackgroundBudget
	active        int
	changed       chan struct{}
	nextRun       uint64
	running       map[uint64]context.CancelFunc
	sink          TransitionSink
	transitionSeq uint64
	auditErr      error
}

// Transition is the immutable resource-authority view emitted whenever the
// effective background budget changes. The base envelope is included so an
// authority sink can independently reject accidental budget relaxation.
type Transition struct {
	Sequence    uint64
	At          time.Time
	Profile     Profile
	DeviceClass string
	Base        BackgroundBudget
	Previous    BackgroundBudget
	Current     BackgroundBudget
}

// TransitionSink receives resource transitions after the governor has already
// applied the safer local budget. Sink failure is observable through AuditError
// but never rolls back throttling, pause or preemption.
type TransitionSink interface {
	RecordResourceTransition(Transition) error
}

func NewGovernor(policy Policy) *Governor {
	return &Governor{
		base:    policy,
		budget:  BaseBackgroundBudget(policy),
		changed: make(chan struct{}),
		running: make(map[uint64]context.CancelFunc),
	}
}

func (g *Governor) signalLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

func (g *Governor) Budget() BackgroundBudget {
	if g == nil {
		return BackgroundBudget{Paused: true, Reasons: []string{"nil-governor"}}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.budget
	b.Reasons = append([]string(nil), b.Reasons...)
	return b
}

func cloneBudget(b BackgroundBudget) BackgroundBudget {
	b.Reasons = append([]string(nil), b.Reasons...)
	return b
}

func budgetsEqual(a, b BackgroundBudget) bool {
	if a.MaxCPUPercent != b.MaxCPUPercent || a.MaxGPUPercent != b.MaxGPUPercent || a.MaxWorkers != b.MaxWorkers || a.Paused != b.Paused || a.Preempt != b.Preempt || len(a.Reasons) != len(b.Reasons) {
		return false
	}
	for i := range a.Reasons {
		if a.Reasons[i] != b.Reasons[i] {
			return false
		}
	}
	return true
}

func (g *Governor) publishTransition(sink TransitionSink, transition Transition) error {
	if sink == nil {
		return nil
	}
	err := sink.RecordResourceTransition(transition)
	g.mu.Lock()
	g.auditErr = err
	g.mu.Unlock()
	return err
}

// SetTransitionSink installs an authority/audit sink and immediately publishes
// the current envelope as an initial state. Updates and publications are
// serialized so sinks observe transitions in Sequence order.
func (g *Governor) SetTransitionSink(sink TransitionSink) error {
	if g == nil {
		return fmt.Errorf("resource governor is nil")
	}
	g.transitionMu.Lock()
	defer g.transitionMu.Unlock()

	g.mu.Lock()
	g.sink = sink
	g.auditErr = nil
	if sink == nil {
		g.mu.Unlock()
		return nil
	}
	g.transitionSeq++
	current := cloneBudget(g.budget)
	transition := Transition{
		Sequence:    g.transitionSeq,
		At:          time.Now().UTC(),
		Profile:     g.base.Profile,
		DeviceClass: string(normalizeDeviceClass(g.base.DeviceClass)),
		Base:        BaseBackgroundBudget(g.base),
		Previous:    cloneBudget(current),
		Current:     current,
	}
	g.mu.Unlock()
	return g.publishTransition(sink, transition)
}

// AuditError reports the most recent transition-sink error. A later successful
// publication clears it. It does not affect local enforcement.
func (g *Governor) AuditError() error {
	if g == nil {
		return fmt.Errorf("resource governor is nil")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.auditErr
}

func (g *Governor) UpdateSignals(signals RuntimeSignals) {
	if g == nil {
		return
	}
	g.UpdateBudget(EffectiveBackgroundBudget(g.base, signals))
}

// UpdateBudget changes future admission immediately. A preempt or paused budget
// cancels all active cooperative units so they can yield to foreground/resource
// pressure. Reducing parallelism alone does not kill already-running work, but
// blocks new admission until the active count falls below the limit.
func (g *Governor) UpdateBudget(budget BackgroundBudget) {
	if g == nil {
		return
	}
	g.transitionMu.Lock()
	defer g.transitionMu.Unlock()
	if budget.MaxWorkers < 1 {
		budget.MaxWorkers = 1
	}
	budget.MaxCPUPercent = clampPercent(budget.MaxCPUPercent)
	budget.MaxGPUPercent = clampPercent(budget.MaxGPUPercent)
	budget = cloneBudget(budget)

	g.mu.Lock()
	previous := cloneBudget(g.budget)
	if budgetsEqual(previous, budget) {
		g.mu.Unlock()
		return
	}
	g.budget = budget
	var cancels []context.CancelFunc
	if budget.Paused || budget.Preempt {
		cancels = make([]context.CancelFunc, 0, len(g.running))
		for _, cancel := range g.running {
			cancels = append(cancels, cancel)
		}
	}
	g.signalLocked()
	sink := g.sink
	var transition Transition
	if sink != nil {
		g.transitionSeq++
		transition = Transition{
			Sequence:    g.transitionSeq,
			At:          time.Now().UTC(),
			Profile:     g.base.Profile,
			DeviceClass: string(normalizeDeviceClass(g.base.DeviceClass)),
			Base:        BaseBackgroundBudget(g.base),
			Previous:    previous,
			Current:     cloneBudget(budget),
		}
	}
	g.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	if sink != nil {
		_ = g.publishTransition(sink, transition)
	}
}

// Cooldown returns the cooperative idle interval required after work to keep a
// single worker near the configured CPU duty cycle.
func (g *Governor) Cooldown(work time.Duration) time.Duration {
	if g == nil || work <= 0 {
		return 0
	}
	b := g.Budget()
	if b.MaxCPUPercent >= 100 {
		return 0
	}
	return time.Duration(int64(work) * int64(100-b.MaxCPUPercent) / int64(b.MaxCPUPercent))
}

func (g *Governor) acquire(ctx context.Context) (context.Context, func(), error) {
	for {
		g.mu.Lock()
		if !g.budget.Paused && g.active < g.budget.MaxWorkers {
			g.active++
			g.nextRun++
			id := g.nextRun
			runCtx, cancel := context.WithCancel(ctx)
			g.running[id] = cancel
			g.mu.Unlock()
			release := func() {
				g.mu.Lock()
				if activeCancel, ok := g.running[id]; ok {
					delete(g.running, id)
					g.active--
					activeCancel()
					g.signalLocked()
				}
				g.mu.Unlock()
			}
			return runCtx, release, nil
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-changed:
			continue
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	}
}

// Run executes one background unit under the worker and CPU-duty budget.
func (g *Governor) Run(ctx context.Context, fn func(context.Context) error) error {
	if g == nil {
		return fmt.Errorf("resource governor is nil")
	}
	if ctx == nil || fn == nil {
		return fmt.Errorf("resource governor requires context and work function")
	}
	runCtx, release, err := g.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	start := time.Now()
	err = fn(runCtx)
	work := time.Since(start)
	if err != nil {
		return err
	}
	if err := runCtx.Err(); err != nil {
		return err
	}
	cooldown := g.Cooldown(work)
	if cooldown <= 0 {
		return nil
	}
	timer := time.NewTimer(cooldown)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-runCtx.Done():
		return runCtx.Err()
	}
}
