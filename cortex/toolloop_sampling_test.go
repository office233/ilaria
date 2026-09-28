package cortex

import (
	"math"
	"math/rand"
	"testing"
)

func TestSampleTopKLimitsAndDistribution(t *testing.T) {
	logits := []float32{0.1, 3, float32(math.NaN()), 2, -1, 2.9}
	rng := rand.New(rand.NewSource(1))
	if got := sampleTopK(logits, 1, 1.0, rng); got != 1 {
		t.Fatalf("k=1 must be argmax, got %d", got)
	}
	counts := map[int]int{}
	for i := 0; i < 20000; i++ {
		counts[sampleTopK(logits, 2, 1.0, rng)]++
	}
	if len(counts) != 2 || counts[1] == 0 || counts[5] == 0 {
		t.Fatalf("top-2 must only return ids 1 and 5: %v", counts)
	}
	// exp(3)/(exp(3)+exp(2.9)) = 0.525
	if p := float64(counts[1]) / 20000; math.Abs(p-0.525) > 0.02 {
		t.Fatalf("p(id 1) = %.3f, want ~0.525", p)
	}
	for i := 0; i < 1000; i++ {
		if got := sampleTopK(logits, 3, 0.001, rng); got != 1 {
			t.Fatalf("near-zero temperature must be argmax, got %d", got)
		}
	}
}

func TestSetSamplingValidatesAndIsReproducible(t *testing.T) {
	r := &Runner{}
	for _, bad := range [][2]float64{{-1, 40}, {6, 40}, {0.7, 0}} {
		if err := r.SetSampling(bad[0], int(bad[1]), 1); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	logits := []float32{1, 1.1, 0.9, 1.05}
	draw := func() []int {
		if err := r.SetSampling(1.0, 4, 42); err != nil {
			t.Fatal(err)
		}
		out := make([]int, 50)
		for i := range out {
			out[i] = r.next(logits)
		}
		return out
	}
	a, b := draw(), draw()
	for i := range a {
		if a[i] != b[i] {
			t.Fatal("same seed must give the same samples")
		}
	}
	if err := r.SetSampling(0, 0, 1); err != nil || r.next(logits) != 1 {
		t.Fatal("temperature 0 must restore greedy argmax")
	}
}
