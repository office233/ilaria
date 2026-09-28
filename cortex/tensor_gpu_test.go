//go:build cuda
// +build cuda

package cortex

import (
	"math"
	"math/rand"
	"testing"

	"ilaria/cortex/compute"
)

// TestMatMulGPUMatchesCPU runs the same matmul on CPU and on GPU
// (forced above the dispatch threshold) and asserts that every element
// matches within float32 round-off. This is the primary safety net for
// the row-major <-> column-major dance inside cublas_matmul.cu.
func TestMatMulGPUMatchesCPU(t *testing.T) {
	if err := compute.InitCuBLAS(); err != nil {
		t.Skipf("cuBLAS init failed (no GPU?): %v", err)
	}
	defer compute.CloseCuBLAS()

	rng := rand.New(rand.NewSource(42))
	// Pick shapes that span the threshold + a typical attention/FFN
	// shape from Broca 2.0 (256 embed, ~50-token sequences).
	cases := []struct{ M, K, N int }{
		{32, 32, 32},    // exactly at threshold
		{64, 256, 256},  // attention Q*K^T-ish (after MatMulNT it's QK)
		{200, 256, 256}, // a longer sequence
		{50, 256, 1024}, // FFN expand
		{50, 1024, 256}, // FFN contract
		{50, 256, 8192}, // logits (vocab=8192)
	}
	for _, c := range cases {
		a := randomTensor(c.M, c.K, rng)
		b := randomTensor(c.K, c.N, rng)

		gpuOut := a.MatMul(b) // dispatches to GPU because shape >= threshold
		cpuOut := cpuMatMul(a, b)
		assertTensorsClose(t, gpuOut, cpuOut, 1e-3, "MatMul %dx%dx%d", c.M, c.K, c.N)
	}
}

// TestMatMulTransposedGPUMatchesCPU is the same check for A * B^T.
func TestMatMulTransposedGPUMatchesCPU(t *testing.T) {
	if err := compute.InitCuBLAS(); err != nil {
		t.Skipf("cuBLAS init failed: %v", err)
	}
	defer compute.CloseCuBLAS()

	rng := rand.New(rand.NewSource(7))
	cases := []struct{ M, K, N int }{
		{32, 32, 32},
		{50, 64, 4}, // attention scores: (seq, head_dim) * (heads*seq, head_dim)^T-ish
		{50, 256, 50},
		{200, 256, 200},
		{50, 256, 8192}, // tied-weight logits via embedding^T
	}
	for _, c := range cases {
		a := randomTensor(c.M, c.K, rng)
		b := randomTensor(c.N, c.K, rng)

		gpuOut := a.MatMulTransposed(b)
		cpuOut := cpuMatMulTransposed(a, b)
		assertTensorsClose(t, gpuOut, cpuOut, 1e-3, "MatMulT %dx%dx%d", c.M, c.K, c.N)
	}
}

// cpuMatMul forces the sequential CPU implementation so the test can
// compare against a known-correct baseline independent of the dispatch
// logic in Tensor.MatMul.
func cpuMatMul(a, b *Tensor) *Tensor {
	M, K := a.Shape[0], a.Shape[1]
	N := b.Shape[1]
	c := NewTensor(M, N)
	matmulRowsSequential(a.Data, b.Data, c.Data, 0, M, K, N)
	return c
}

func cpuMatMulTransposed(a, b *Tensor) *Tensor {
	M, K := a.Shape[0], a.Shape[1]
	N := b.Shape[0]
	c := NewTensor(M, N)
	matmulTRowsSequential(a.Data, b.Data, c.Data, 0, M, K, N)
	return c
}

func randomTensor(rows, cols int, rng *rand.Rand) *Tensor {
	t := NewTensor(rows, cols)
	for i := range t.Data {
		t.Data[i] = rng.Float32()*2 - 1 // [-1, 1)
	}
	return t
}

func assertTensorsClose(t *testing.T, got, want *Tensor, tol float64, label string, args ...any) {
	t.Helper()
	if len(got.Data) != len(want.Data) {
		t.Fatalf("%s: length mismatch got=%d want=%d", label, len(got.Data), len(want.Data))
	}
	for i := range got.Data {
		diff := math.Abs(float64(got.Data[i] - want.Data[i]))
		// cuBLAS uses different summation order so absolute error scales with K.
		// 1e-3 absolute is generous enough for any K up to ~10000 with values in [-1,1].
		if diff > tol {
			t.Fatalf("%s: element %d mismatch got=%f want=%f diff=%g",
				label, i, got.Data[i], want.Data[i], diff)
		}
	}
}
