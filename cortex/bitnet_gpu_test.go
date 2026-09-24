//go:build gpu

package cortex

import (
	"math/rand"
	"testing"

	"nexus-cortex/cortex/compute"
)

// TestBitLinearGPUMatchesCPU builds a small random BitLinear, computes
// ForwardBatch on the CPU (l.gpu is nil), attaches a GPU backend — the
// same unpack/upload/attach EnableBitNetGPU performs, applied here to a
// single standalone layer instead of a whole model — and checks the
// GPU-backed ForwardBatch call against it.
//
// Both paths accumulate the ternary dot product as an EXACT int32 sum
// (proven bit-for-bit against a plain Go reference by
// TestMatMulInt8NTTinyAgainstReference in
// cortex/compute/cublas_int8_dyn_test.go — integer addition has no
// rounding or association-order sensitivity), so any difference here can
// only come from the float32 rescale's multiplication order. That
// order is NOT a simple function of Out%4 on the CPU side: bitnetParallelFor
// (bitnet_linear.go) splits Out into chunk=ceil(Out/GOMAXPROCS(0))-wide
// spans, and bitLinearForwardRows only takes its 4-row-at-a-time
// `f:=xScale*Scale; acc*f` branch (the order bitLinearGPUImpl.forward
// also uses) for the part of EACH chunk that is itself a multiple of 4 —
// any remainder falls to the single-row tail branch's left-to-right
// `acc*xScale*Scale` instead. Since chunk width depends on the runtime
// GOMAXPROCS, which branch a given row takes is machine-dependent even
// for the same Out (this test's Out=24 hits the tail branch for EVERY
// row on an 8-core machine: chunk=ceil(24/8)=3, and 3<4 never enters the
// x4 branch at all) — so exact equality isn't a meaningful bound here.
// Per the task contract's documented fallback, this compares with a
// tight relative-L2 tolerance (bitnet_test.go's relativeL2 helper, same
// one TestBitLinearIntegerAccumulation uses) instead, at a bound many
// orders tighter than the statistical bounds TestBitNetEquivalence uses
// for the same reason at full model scale. In=37 is deliberately not a
// multiple of 16 (exercises SetRow/unpackBitLinearInt8's tile padding)
// nor of 4 (exercises MatMulInt8NT's pad4 path on the GPU side). Skipped
// when no CUDA device/driver is present.
func TestBitLinearGPUMatchesCPU(t *testing.T) {
	if err := compute.InitCuBLASInt8(); err != nil {
		t.Skipf("cuda int8 not available: %v", err)
	}

	rng := rand.New(rand.NewSource(99))
	const in, out, T = 37, 24, 5

	l := NewBitLinear(in, out)
	l.Scale = 0.037
	rows := randomTernaryRows(rng, out, in)
	for o, row := range rows {
		l.SetRow(o, row)
	}

	x := make([][]float32, T)
	for t := range x {
		row := make([]float32, in)
		for i := range row {
			row[i] = rng.Float32()*2 - 1
		}
		x[t] = row
	}

	want := l.ForwardBatch(x) // CPU path (l.gpu is nil so far)

	data := unpackBitLinearInt8(l)
	handle, err := compute.UploadInt8Weight(data, out, in)
	if err != nil {
		t.Fatalf("UploadInt8Weight: %v", err)
	}
	defer compute.FreeInt8Weight(handle)
	l.gpu = &bitLinearGPUImpl{handle: handle, out: out, in: in, scale: l.Scale}

	got := l.ForwardBatch(x) // now the GPU path, via the ForwardBatch hook
	if len(got) != len(want) {
		t.Fatalf("len(got)=%d want %d", len(got), len(want))
	}

	const tol = 1e-6 // far tighter than float32 epsilon (~1.2e-7) accumulated over one rescale multiply
	var acc relativeL2
	maxAbsDiff := float32(0)
	for ti := range want {
		if len(got[ti]) != len(want[ti]) {
			t.Fatalf("row %d: len(got)=%d want %d", ti, len(got[ti]), len(want[ti]))
		}
		acc.add(toFloat64(got[ti]), toFloat64(want[ti]))
		for j := range want[ti] {
			d := got[ti][j] - want[ti][j]
			if d < 0 {
				d = -d
			}
			if d > maxAbsDiff {
				maxAbsDiff = d
			}
		}
	}
	if rel := acc.finish(); rel > tol {
		t.Errorf("GPU vs CPU relative L2 = %.3e (bound %.0e), max|Δ| = %.3e", rel, tol, maxAbsDiff)
	} else {
		t.Logf("GPU vs CPU relative L2 = %.3e (bound %.0e), max|Δ| = %.3e — within float32-rescale-order tolerance", rel, tol, maxAbsDiff)
	}
}

// TestBitLinearGPUForwardBatchDispatch checks the ForwardBatch hook
// itself in isolation (l.gpu != nil routes to it, nil routes to CPU) on
// a trivial 1x1 case, independent of numeric correctness.
func TestBitLinearGPUForwardBatchDispatch(t *testing.T) {
	if err := compute.InitCuBLASInt8(); err != nil {
		t.Skipf("cuda int8 not available: %v", err)
	}

	l := NewBitLinear(4, 4)
	l.Scale = 1
	l.SetRow(0, []int8{1, -1, 0, 1})
	l.SetRow(1, []int8{0, 1, 1, -1})
	l.SetRow(2, []int8{-1, -1, 1, 0})
	l.SetRow(3, []int8{1, 1, 1, 1})

	x := [][]float32{{1, 2, 3, 4}}
	cpuOut := l.ForwardBatch(x)

	data := unpackBitLinearInt8(l)
	handle, err := compute.UploadInt8Weight(data, 4, 4)
	if err != nil {
		t.Fatalf("UploadInt8Weight: %v", err)
	}
	defer compute.FreeInt8Weight(handle)
	l.gpu = &bitLinearGPUImpl{handle: handle, out: 4, in: 4, scale: 1}

	gpuOut := l.ForwardBatch(x)
	l.gpu = nil // detach so a later CPU-only run of this test binary is unaffected

	if len(cpuOut) != 1 || len(gpuOut) != 1 || len(cpuOut[0]) != 4 || len(gpuOut[0]) != 4 {
		t.Fatalf("unexpected shapes: cpu=%v gpu=%v", cpuOut, gpuOut)
	}
	for j := 0; j < 4; j++ {
		if cpuOut[0][j] != gpuOut[0][j] {
			t.Errorf("[0][%d] cpu=%v gpu=%v", j, cpuOut[0][j], gpuOut[0][j])
		}
	}
}
