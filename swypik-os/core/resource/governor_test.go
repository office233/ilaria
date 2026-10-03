package resource

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type recordingTransitionSink struct {
	mu          sync.Mutex
	transitions []Transition
	fail        bool
}

func (s *recordingTransitionSink) RecordResourceTransition(transition Transition) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.transitions = append(s.transitions, transition)
	if s.fail {
		return errors.New("audit unavailable")
	}
	return nil
}

func (s *recordingTransitionSink) snapshot() []Transition {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Transition(nil), s.transitions...)
}

func TestGovernorCooldownMatchesDutyCycle(t *testing.T) {
	g := NewGovernor(Policy{MaxBackgroundWorkers: 1, MaxBackgroundCPUPercent: 20})
	if got, want := g.Cooldown(10*time.Millisecond), 40*time.Millisecond; got != want {
		t.Fatalf("cooldown=%s want %s", got, want)
	}
	if got := NewGovernor(Policy{MaxBackgroundWorkers: 1, MaxBackgroundCPUPercent: 100}).Cooldown(time.Second); got != 0 {
		t.Fatalf("100%% duty cooldown=%s want 0", got)
	}
}

func TestGovernorBoundsConcurrentWorkers(t *testing.T) {
	g := NewGovernor(Policy{MaxBackgroundWorkers: 2, MaxBackgroundCPUPercent: 100})
	ctx := context.Background()
	var active atomic.Int32
	var peak atomic.Int32
	start := make(chan struct{}, 8)
	release := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := g.Run(ctx, func(context.Context) error {
				n := active.Add(1)
				for {
					old := peak.Load()
					if n <= old || peak.CompareAndSwap(old, n) {
						break
					}
				}
				select {
				case start <- struct{}{}:
				default:
				}
				<-release
				active.Add(-1)
				return nil
			}); err != nil {
				t.Errorf("run: %v", err)
			}
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-start:
		case <-time.After(time.Second):
			t.Fatal("workers did not start")
		}
	}
	if got := peak.Load(); got != 2 {
		t.Fatalf("peak=%d want 2", got)
	}
	close(release)
	wg.Wait()
}

func TestGovernorCancellationWinsDuringCooldown(t *testing.T) {
	g := NewGovernor(Policy{MaxBackgroundWorkers: 1, MaxBackgroundCPUPercent: 1})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- g.Run(ctx, func(context.Context) error {
			time.Sleep(time.Millisecond)
			return nil
		})
	}()
	time.Sleep(5 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("governor did not cancel")
	}
}

func TestGovernorPublishesOnlyBudgetTransitionsAndAuditFailureDoesNotRelaxSafety(t *testing.T) {
	g := NewGovernor(ForProfile(ProfileBalanced))
	sink := &recordingTransitionSink{}
	if err := g.SetTransitionSink(sink); err != nil {
		t.Fatal(err)
	}
	initial := sink.snapshot()
	if len(initial) != 1 || initial[0].Sequence != 1 || initial[0].Profile != ProfileBalanced || !budgetsEqual(initial[0].Base, initial[0].Current) {
		t.Fatalf("initial transition=%+v", initial)
	}

	// A sample that leaves the effective envelope unchanged is not journal noise.
	g.UpdateSignals(RuntimeSignals{BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	if got := len(sink.snapshot()); got != 1 {
		t.Fatalf("unchanged budget emitted %d transitions, want 1", got)
	}

	g.UpdateSignals(RuntimeSignals{UserActive: true, BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	items := sink.snapshot()
	if len(items) != 2 || items[1].Sequence != 2 || !items[1].Current.Preempt || items[1].Current.MaxWorkers != 1 {
		t.Fatalf("foreground transition=%+v", items)
	}
	// Repeating the same pressure sample must not emit a duplicate transition.
	g.UpdateSignals(RuntimeSignals{UserActive: true, BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	if got := len(sink.snapshot()); got != 2 {
		t.Fatalf("duplicate pressure emitted %d transitions, want 2", got)
	}

	sink.mu.Lock()
	sink.fail = true
	sink.mu.Unlock()
	g.UpdateSignals(RuntimeSignals{OnBattery: true, BatteryPercent: 10, MemoryLoadPercent: 20, ThermalCelsius: -1})
	if !g.Budget().Paused {
		t.Fatal("audit failure prevented critical-pressure pause")
	}
	if g.AuditError() == nil {
		t.Fatal("audit failure was not surfaced")
	}

	sink.mu.Lock()
	sink.fail = false
	sink.mu.Unlock()
	g.UpdateSignals(RuntimeSignals{BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	if g.Budget().Paused || g.AuditError() != nil {
		t.Fatalf("recovery budget=%+v audit=%v", g.Budget(), g.AuditError())
	}
}
