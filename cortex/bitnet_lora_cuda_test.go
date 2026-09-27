//go:build gpu

package cortex

import (
	"math"
	"testing"
)

func TestBitNetLoRACUDA(t *testing.T) {
	// Distinguish unavailable hardware from a broken new kernel.
	compiledCUDAModule(t)
	m := tinyLoRAModel()
	if err := LoadBitNetLoRA(m, writeLoRAFixture(t, m)); err != nil {
		t.Fatal(err)
	}
	d, err := NewBitNetCUDADecoder(m)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	cpu := NewBitNetDecoder(m)
	check := func(got, want []float32) {
		t.Helper()
		for i, v := range got {
			if math.Abs(float64(v-want[i])) > 0.003 {
				t.Fatalf("logit %d: GPU %g CPU %g", i, v, want[i])
			}
		}
	}
	check(d.Prefill([]int{1, 2}), cpu.Prefill([]int{1, 2}))
	check(d.Step(3), cpu.Step(3))
	d.Reset()
	cpu.Reset()
	check(d.Prefill([]int{4, 5}), cpu.Prefill([]int{4, 5}))
}
