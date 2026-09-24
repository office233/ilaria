//go:build !gpu

// bitnet_gpu_stub.go — default-build stand-in for bitnet_gpu.go. No
// BitLinear's `gpu` field is ever set here, so ForwardBatch
// (bitnet_linear.go) always takes the CPU path.
package cortex

import "errors"

// EnableBitNetGPU stub: GPU support was not compiled in. Rebuild with
// `-tags gpu` (Windows, cgo/MinGW gcc, CUDA runtime + cuBLAS DLLs — see
// cortex/compute/cublas_int8_dyn.go) to enable it.
func EnableBitNetGPU(m *BitNetModel) error {
	return errors.New("bitnet gpu backend not compiled in (rebuild with -tags gpu)")
}

// DisableBitNetGPU is a no-op stub — nothing was ever enabled.
func DisableBitNetGPU(m *BitNetModel) {}
