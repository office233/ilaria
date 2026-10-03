package tritpack20

import (
	"errors"
	"math"
	"testing"
)

func TestMatVecParityIndependentScalarReferenceNonSquare(t *testing.T) {
	const (
		in  = 5
		out = 3
	)
	trits := []int8{
		-1, 0, 1,
		1, 1, 0,
		0, -1, 1,
		1, 0, -1,
		-1, 1, 1,
	}
	activations := []int8{-128, -3, 0, 7, 127}
	weightScale := float32(0.1875)
	activationScale := float32(0.03125)

	snapshot, err := NewSnapshot(in, out, weightScale, trits, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	got := make([]float32, out)
	if err := snapshot.MatVec(got, activations, activationScale); err != nil {
		t.Fatal(err)
	}
	want := independentReferenceMatVec(trits, in, out, weightScale, activations, activationScale)
	for i := range got {
		if !closeFP32(got[i], want[i]) {
			t.Fatalf("output[%d] = %.9g, want %.9g (abs=%g)", i, got[i], want[i], math.Abs(float64(got[i]-want[i])))
		}
	}
}

func TestMatVecSafeIntegerAccumulationAndExactSimpleCase(t *testing.T) {
	const in = 100_000
	trits := make([]int8, in)
	activations := make([]int8, in)
	for i := range trits {
		trits[i] = 1
		activations[i] = -128
	}
	snapshot, err := NewSnapshot(in, 1, 0.5, trits, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	dst := []float32{123}
	if err := snapshot.MatVec(dst, activations, 0.25); err != nil {
		t.Fatal(err)
	}
	const integerSum = int64(in) * -128
	want := float32(integerSum) * 0.25 * 0.5
	if dst[0] != want {
		t.Fatalf("output = %g, want %g", dst[0], want)
	}
}

func TestMatVecBoundsAndScaleValidation(t *testing.T) {
	snapshot, err := NewSnapshot(2, 3, 1, []int8{-1, 0, 1, 1, 0, -1}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if err := snapshot.MatVec(make([]float32, 2), make([]int8, 2), 1); !errors.Is(err, ErrBounds) {
		t.Fatalf("short dst error = %v", err)
	}
	if err := snapshot.MatVec(make([]float32, 3), make([]int8, 1), 1); !errors.Is(err, ErrBounds) {
		t.Fatalf("short activation error = %v", err)
	}
	var nilSnapshot *Snapshot
	if err := nilSnapshot.MatVec(make([]float32, 3), make([]int8, 2), 1); !errors.Is(err, ErrBounds) {
		t.Fatalf("nil snapshot error = %v", err)
	}

	for name, scale := range map[string]float32{
		"zero":     0,
		"negative": -1,
		"nan":      float32(math.NaN()),
		"infinity": float32(math.Inf(1)),
	} {
		t.Run(name, func(t *testing.T) {
			if err := snapshot.MatVec(make([]float32, 3), make([]int8, 2), scale); !errors.Is(err, ErrScale) {
				t.Fatalf("scale error = %v", err)
			}
		})
	}

	hugeScaleSnapshot, err := NewSnapshot(1, 1, math.MaxFloat32, []int8{1}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if err := hugeScaleSnapshot.MatVec(make([]float32, 1), []int8{1}, 2); !errors.Is(err, ErrScale) {
		t.Fatalf("combined scale overflow error = %v", err)
	}
}

func TestMatVecZeroAllocationsAfterSnapshotInitialization(t *testing.T) {
	const (
		in  = 64
		out = 48
	)
	trits := make([]int8, in*out)
	for i := range trits {
		trits[i] = int8(i%3) - 1
	}
	snapshot, err := NewSnapshot(in, out, 0.125, trits, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	activations := make([]int8, in)
	for i := range activations {
		activations[i] = int8((i*17)%255 - 128)
	}
	dst := make([]float32, out)
	if err := snapshot.MatVec(dst, activations, 0.015625); err != nil {
		t.Fatal(err)
	}
	allocs := testing.AllocsPerRun(1000, func() {
		if err := snapshot.MatVec(dst, activations, 0.015625); err != nil {
			panic(err)
		}
	})
	if allocs != 0 {
		t.Fatalf("MatVec allocations = %g, want 0", allocs)
	}
}

func independentReferenceMatVec(
	trits []int8,
	in, out int,
	weightScale float32,
	activations []int8,
	activationScale float32,
) []float32 {
	result := make([]float32, out)
	for o := 0; o < out; o++ {
		var acc int64
		for i := 0; i < in; i++ {
			acc += int64(activations[i]) * int64(trits[i*out+o])
		}
		result[o] = float32(float64(acc) * float64(activationScale) * float64(weightScale))
	}
	return result
}

// closeFP32 allows two correctly rounded FP32 evaluation orders to differ by a
// small amount while keeping the integer accumulation comparison exact.
func closeFP32(got, want float32) bool {
	diff := math.Abs(float64(got - want))
	scale := math.Max(1, math.Abs(float64(want)))
	return diff <= 2e-6*scale
}
