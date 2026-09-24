package cortex

// bitnet_backend.go — the GPU dispatch seam for BitLinear.ForwardBatch.
//
// bitLinearGPU is the interface BitLinear.ForwardBatch (bitnet_linear.go)
// checks at its top via the "GPU HOOK" — a nil-checked field named `gpu`
// on the BitLinear struct. Two implementations exist, selected entirely
// by build tag:
//
//   - bitnet_gpu.go (tag `gpu`): bitLinearGPUImpl, a resident cuBLAS
//     int8 GEMM backend (cortex/compute's cublas_int8_dyn.go). Attached
//     by EnableBitNetGPU.
//   - bitnet_gpu_stub.go (tag `!gpu`): EnableBitNetGPU always errors and
//     no BitLinear's gpu field is ever set, so ForwardBatch always takes
//     the CPU path.
//
// This file itself carries no build tag — the interface type must exist
// in every build so bitnet_linear.go's `gpu bitLinearGPU` field
// declaration compiles regardless of tags.
type bitLinearGPU interface {
	// forward must return BIT-IDENTICAL results to what
	// bitLinearForwardRows (bitnet_linear.go) would compute for the same
	// BitLinear and the same x — same quantizeActivationsInt8 call, same
	// exact int32 accumulation, same `float32(acc) * xScale * Scale`
	// left-to-right rescale order. ForwardBatch's own contract (see its
	// doc comment) promises callers identical results regardless of
	// batch size/parallelism; a gpu backend must preserve that promise
	// too.
	forward(x [][]float32) [][]float32
}
