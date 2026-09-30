package swarm

import (
	"context"
	"sync"
	"testing"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

type fixedSignalSource struct {
	signals resourcepolicy.RuntimeSignals
}

func (s fixedSignalSource) Sample(context.Context) (resourcepolicy.RuntimeSignals, error) {
	return s.signals, nil
}

func TestSwarmDaemonLifecycle(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	d := NewDaemon()
	defer d.Stop()

	initial := d.GetStatus()
	if !initial.Enabled {
		t.Errorf("Expected daemon to be enabled by default")
	}

	d.Toggle()
	if d.GetStatus().Enabled {
		t.Errorf("Expected daemon to be disabled after toggle")
	}

	d.Toggle()
	if !d.GetStatus().Enabled {
		t.Errorf("Expected daemon to be re-enabled after toggle")
	}

	time.Sleep(100 * time.Millisecond)

	// Regression test: multiple Stop() calls must never panic
	d.Stop()
	d.Stop()
	d.Stop()
}

func TestAdaptiveSignalSourceAddsAvailableGPUThermalTelemetry(t *testing.T) {
	source := adaptiveSignalSource{
		base: fixedSignalSource{signals: resourcepolicy.RuntimeSignals{
			BatteryPercent:    -1,
			MemoryLoadPercent: 42,
			ThermalCelsius:    -1,
		}},
		thermal: func() (int, bool) { return 79, true },
	}
	signals, err := source.Sample(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if signals.ThermalCelsius != 79 || signals.MemoryLoadPercent != 42 {
		t.Fatalf("signals=%+v", signals)
	}
}

func TestAdaptiveSignalSourcePreservesUnknownThermalWhenUnavailable(t *testing.T) {
	source := adaptiveSignalSource{
		base:    fixedSignalSource{signals: resourcepolicy.RuntimeSignals{ThermalCelsius: -1}},
		thermal: func() (int, bool) { return 0, false },
	}
	signals, err := source.Sample(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if signals.ThermalCelsius != -1 {
		t.Fatalf("thermal=%d want unknown", signals.ThermalCelsius)
	}
}

func TestSwarmEnabledIdleDoesNoSyntheticCompute(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	d := NewDaemon(SwarmConfig{Enabled: true, TrainingEnabled: true})
	defer d.Stop()

	time.Sleep(50 * time.Millisecond)
	if got := d.GetStatus().RealHashRate; got != 0 {
		t.Fatalf("idle swarm reported fabricated hashrate: %v", got)
	}
}

func TestStoppedSwarmCannotRestartAdaptiveMonitor(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	d := NewDaemon(SwarmConfig{Enabled: true, TrainingEnabled: true})
	d.Stop()

	if !d.stopped.Load() {
		t.Fatal("daemon did not record terminal stopped state")
	}
	d.Toggle()
	if !d.GetStatus().Enabled {
		t.Fatal("toggle after Stop changed terminal daemon state")
	}
	d.mu.RLock()
	cancel, done := d.governorCancel, d.governorDone
	d.mu.RUnlock()
	if cancel != nil || done != nil {
		t.Fatal("toggle after Stop restarted adaptive resource monitor")
	}
	if _, _, err := d.ExecuteTrainingMicroBatchContext(context.Background(), 1); err == nil || err.Error() != "daemon stopped" {
		t.Fatalf("training after Stop err=%v want daemon stopped", err)
	}
}

type swarmTransitionSink struct {
	mu    sync.Mutex
	items []resourcepolicy.Transition
}

func (s *swarmTransitionSink) RecordResourceTransition(transition resourcepolicy.Transition) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append(s.items, transition)
	return nil
}

func TestSwarmAcceptsInjectedResourceAuthorityWithoutOwningItsLifecycle(t *testing.T) {
	d := NewDaemon(SwarmConfig{Enabled: false, TrainingEnabled: false})
	sink := &swarmTransitionSink{}
	if err := d.SetResourceTransitionSink(sink); err != nil {
		t.Fatal(err)
	}
	status := d.GetStatus()
	if status.ResourceBudget.MaxWorkers < 1 || status.ResourceBudget.MaxCPUPercent < 1 || status.ResourceAuditError != "" {
		t.Fatalf("resource status=%+v", status)
	}
	sink.mu.Lock()
	count := len(sink.items)
	sink.mu.Unlock()
	if count != 1 {
		t.Fatalf("initial resource authority transitions=%d want 1", count)
	}
	d.Stop()
	if err := d.SetResourceTransitionSink(sink); err == nil || err.Error() != "daemon stopped" {
		t.Fatalf("authority attachment after Stop err=%v", err)
	}
}

func TestSwarmDisabledDefersTrainerAndHardwareWork(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	d := NewDaemon(SwarmConfig{Enabled: false, TrainingEnabled: false})
	defer d.Stop()
	if d.trainer != nil {
		t.Fatal("disabled swarm eagerly allocated trainer")
	}
	status := d.GetStatus()
	if status.HasGPU || status.VRAMMB != 0 || status.LocalTflops != 0 {
		t.Fatalf("disabled swarm eagerly probed hardware: %+v", status)
	}
}

func TestSwarmGPUAutoDetection(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	d := NewDaemon()
	defer d.Stop()

	status := d.GetStatus()
	t.Logf("Swarm Status GPU Info -> HasGPU: %v | Model: %s | VRAM: %d MB | CUDA: %s | TFLOPS: %.1f",
		status.HasGPU, status.GPUModel, status.VRAMMB, status.CUDAVersion, status.LocalTflops)

	// nvidia-smi inventory proves identity and VRAM, not measured throughput.
	// Zero means unknown until an explicit benchmark supplies a measurement.
	// This contract must hold on GPU-equipped hosts as well as CPU-only CI.
	if status.LocalTflops != 0 {
		t.Errorf("inventory must not fabricate measured TFLOPS, got %v", status.LocalTflops)
	}
	if status.HasGPU {
		if status.GPUModel == "" {
			t.Errorf("Expected non-empty GPUModel when HasGPU is true")
		}
		if status.VRAMMB <= 0 {
			t.Errorf("detected GPU inventory must include positive VRAM, got %d", status.VRAMMB)
		}
	} else if status.VRAMMB != 0 {
		t.Errorf("no detected GPU must not report VRAM, got %d", status.VRAMMB)
	}
}
