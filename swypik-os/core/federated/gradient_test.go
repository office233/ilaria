package federated

import (
	"math"
	"testing"
)

func TestRealGradientUpdateIsAtomic(t *testing.T) {
	cfg := DefaultDiLoCoConfig()
	cfg.InnerSteps = 2
	cfg.InnerLR = 0.1
	w := NewDiLoCoWorker("test", "", 0, 0, cfg)
	w.SyncBaseModel(&ModelCheckpoint{Weights: map[string][]float64{"x": {1, 2}}})
	if _, _, err := w.StepInner(map[string][]float64{"x": {1, math.NaN()}}); err == nil {
		t.Fatal("accepted NaN")
	}
	delta, _ := w.ComputeOuterPseudoGradient("x")
	if delta[0] != 0 || delta[1] != 0 {
		t.Fatal("partial invalid update")
	}
	if _, p, err := w.StepInner(map[string][]float64{"x": {1, -2}}); err != nil || p != 0.5 {
		t.Fatalf("%g %v", p, err)
	}
	delta, _ = w.ComputeOuterPseudoGradient("x")
	if math.Abs(delta[0]+0.1) > 1e-12 || math.Abs(delta[1]-0.2) > 1e-12 {
		t.Fatalf("not SGD: %v", delta)
	}
}
