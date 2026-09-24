//go:build !gpu

// bitnet_cuda_stub.go — default-build stand-in for bitnet_cuda.go. No
// CUDA kernels are compiled and no device memory is touched; every
// method is a stub so callers (cmd/bitnet-run's `-cuda` flag) compile
// unconditionally and fail cleanly at runtime with a clear message
// instead of at compile time.
package cortex

import "errors"

// BitNetCUDADecoder stub — an always-empty placeholder. The real type
// (bitnet_cuda.go, tag `gpu`) holds every GPU-resident weight/KV-cache
// buffer; this build has none of that compiled in.
type BitNetCUDADecoder struct{}

// NewBitNetCUDADecoder stub: CUDA decode support was not compiled in.
// Rebuild with `-tags gpu` (Windows, cgo/MinGW gcc, CUDA runtime +
// driver + NVRTC — see cortex/compute/nvrtc_dyn.go and
// cuda_driver_dyn.go) to enable it.
func NewBitNetCUDADecoder(m *BitNetModel) (*BitNetCUDADecoder, error) {
	return nil, errors.New("bitnet CUDA decoder not compiled in (rebuild with -tags gpu)")
}

// Len stub always reports 0.
func (d *BitNetCUDADecoder) Len() int { return 0 }

// Reset stub is a no-op.
func (d *BitNetCUDADecoder) Reset() {}

// Prefill stub always panics — construction already fails in stub
// builds, so a caller reaching this has ignored NewBitNetCUDADecoder's
// error.
func (d *BitNetCUDADecoder) Prefill(ids []int) []float32 {
	panic("cortex: BitNetCUDADecoder.Prefill: not compiled in (rebuild with -tags gpu)")
}

// PrefillEmbeds stub always panics, same rationale as Prefill.
func (d *BitNetCUDADecoder) PrefillEmbeds(embeds [][]float32) []float32 {
	panic("cortex: BitNetCUDADecoder.PrefillEmbeds: not compiled in (rebuild with -tags gpu)")
}

// Step stub always panics.
func (d *BitNetCUDADecoder) Step(id int) []float32 {
	panic("cortex: BitNetCUDADecoder.Step: not compiled in (rebuild with -tags gpu)")
}

// Argmax stub always panics.
func (d *BitNetCUDADecoder) Argmax() int {
	panic("cortex: BitNetCUDADecoder.Argmax: not compiled in (rebuild with -tags gpu)")
}

// Close stub is a no-op.
func (d *BitNetCUDADecoder) Close() {}
