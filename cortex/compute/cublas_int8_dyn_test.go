//go:build gpu && windows

package compute

import (
	"math/rand"
	"testing"
)

// TestMatMulInt8NTTinyAgainstReference exercises the cuBLAS int8 GEMM
// path (padding included: In=5 pads to 8, T=3 pads to 4, Out=4 is
// already a multiple of 4) against a plain Go int32 reference — the
// "tiny 3×5×4 case" the GPU BitLinear task calls for, deliberately using
// an In that is NOT a multiple of 4 so the pad4 path is actually
// exercised. Both sides accumulate the same int8×int8 products as exact
// int32 sums, so the comparison is exact equality, not a tolerance.
// Skipped when no CUDA device/driver is present.
func TestMatMulInt8NTTinyAgainstReference(t *testing.T) {
	if err := InitCuBLASInt8(); err != nil {
		t.Skipf("cuda int8 not available: %v", err)
	}

	const T, In, Out = 3, 5, 4
	rng := rand.New(rand.NewSource(7))

	weight := make([]int8, Out*In) // values in {-1,0,1}, like a BitLinear row
	for i := range weight {
		weight[i] = int8(rng.Intn(3) - 1)
	}
	act := make([]int8, T*In) // values in [-128,127], like quantized activations
	for i := range act {
		act[i] = int8(rng.Intn(255) - 128)
	}

	want := make([]int32, T*Out)
	for t := 0; t < T; t++ {
		for o := 0; o < Out; o++ {
			var acc int32
			for i := 0; i < In; i++ {
				acc += int32(act[t*In+i]) * int32(weight[o*In+i])
			}
			want[t*Out+o] = acc
		}
	}

	handle, err := UploadInt8Weight(weight, Out, In)
	if err != nil {
		t.Fatalf("UploadInt8Weight: %v", err)
	}
	defer FreeInt8Weight(handle)

	got, err := MatMulInt8NT(handle, act, T, Out, In)
	if err != nil {
		t.Fatalf("MatMulInt8NT: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("len(got)=%d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("result[%d] = %d, want %d", i, got[i], want[i])
		}
	}
}

// TestMatMulInt8NTAlignedShape checks a shape matching the real model's
// alignment (all dims already multiples of 4, e.g. In=8,Out=8,T=4) so
// the no-padding fast path (UploadInt8Weight/MatMulInt8NT skip the
// copy-into-a-padded-buffer step when dims are already aligned) is also
// covered, not just the padded tiny case above.
func TestMatMulInt8NTAlignedShape(t *testing.T) {
	if err := InitCuBLASInt8(); err != nil {
		t.Skipf("cuda int8 not available: %v", err)
	}

	const T, In, Out = 4, 8, 8
	rng := rand.New(rand.NewSource(11))

	weight := make([]int8, Out*In)
	for i := range weight {
		weight[i] = int8(rng.Intn(3) - 1)
	}
	act := make([]int8, T*In)
	for i := range act {
		act[i] = int8(rng.Intn(255) - 128)
	}

	want := make([]int32, T*Out)
	for t := 0; t < T; t++ {
		for o := 0; o < Out; o++ {
			var acc int32
			for i := 0; i < In; i++ {
				acc += int32(act[t*In+i]) * int32(weight[o*In+i])
			}
			want[t*Out+o] = acc
		}
	}

	handle, err := UploadInt8Weight(weight, Out, In)
	if err != nil {
		t.Fatalf("UploadInt8Weight: %v", err)
	}
	defer FreeInt8Weight(handle)

	got, err := MatMulInt8NT(handle, act, T, Out, In)
	if err != nil {
		t.Fatalf("MatMulInt8NT: %v", err)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("result[%d] = %d, want %d", i, got[i], want[i])
		}
	}
}

// TestMemInfoInt8 sanity-checks cudaMemGetInfo plumbing.
func TestMemInfoInt8(t *testing.T) {
	if err := InitCuBLASInt8(); err != nil {
		t.Skipf("cuda int8 not available: %v", err)
	}
	free, total, err := MemInfoInt8()
	if err != nil {
		t.Fatalf("MemInfoInt8: %v", err)
	}
	if total == 0 || free > total {
		t.Fatalf("implausible meminfo free=%d total=%d", free, total)
	}
	t.Logf("device memory: free=%d MiB total=%d MiB", free/1024/1024, total/1024/1024)
}
