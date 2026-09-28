package hal

import (
	"math"
	"testing"
)

func TestCUDADriverInitializationAndTelemetry(t *testing.T) {
	driver := NewCUDADriver()
	if err := driver.Init(); err != nil {
		t.Fatalf("Failed to initialize CUDA driver: %v", err)
	}

	freeMB, totalMB, err := driver.GetMemoryInfo()
	if err != nil {
		t.Logf("Memory telemetry unavailable on this host: %v", err)
	}
	t.Logf("CUDA VRAM -> Free: %d MB | Total: %d MB", freeMB, totalMB)

	if freeMB < 0 || totalMB < 0 || freeMB > totalMB {
		t.Errorf("Invalid memory telemetry: free=%d total=%d", freeMB, totalMB)
	}

	telem, err := driver.GetTelemetry()
	if err != nil {
		t.Fatalf("GetTelemetry failed: %v", err)
	}
	t.Logf("NVIDIA Live Hardware Telemetry: %+v", telem)

	if telem.DeviceName == "" {
		t.Errorf("Expected non-empty device name")
	}
	if telem.TemperatureC > 120 {
		t.Errorf("Suspicious GPU temperature: %d C", telem.TemperatureC)
	}

	// Test Tensors MicroKernel
	weights := []float32{0.5, -0.2, 0.8, 1.2}
	inputs := []float32{1.0, 2.0, -1.0, 0.5}
	out, err := driver.ExecuteTensorsMicroKernel(weights, inputs)
	if err != nil {
		t.Fatalf("ExecuteTensorsMicroKernel failed: %v", err)
	}
	if len(out) != 4 {
		t.Errorf("Expected output length 4, got %d", len(out))
	}
}

func TestSiLUActivation(t *testing.T) {
	d := NewCUDADriver()
	out, err := d.ExecuteTensorsMicroKernel([]float32{1, 1, 1}, []float32{-2, -1, 2})
	if err != nil {
		t.Fatal(err)
	}
	for i, x := range []float64{-2, -1, 2} {
		want := x / (1 + math.Exp(-x))
		if math.Abs(float64(out[i])-want) > 1e-6 {
			t.Errorf("SiLU(%v)=%v, want %v", x, out[i], want)
		}
	}
}
