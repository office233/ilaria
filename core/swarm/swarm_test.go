package swarm

import (
	"testing"
	"time"
)

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

func TestSwarmGPUAutoDetection(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	d := NewDaemon()
	defer d.Stop()

	status := d.GetStatus()
	t.Logf("Swarm Status GPU Info -> HasGPU: %v | Model: %s | VRAM: %d MB | CUDA: %s | TFLOPS: %.1f",
		status.HasGPU, status.GPUModel, status.VRAMMB, status.CUDAVersion, status.LocalTflops)

	if status.HasGPU {
		if status.LocalTflops < 2.0 {
			t.Errorf("Expected GPU TFLOPS to reflect physical hardware (>= 2.0), got %.1f", status.LocalTflops)
		}
		if status.GPUModel == "" {
			t.Errorf("Expected non-empty GPUModel when HasGPU is true")
		}
	}
}
