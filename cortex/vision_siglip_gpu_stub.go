//go:build !gpu

// vision_siglip_gpu_stub.go — default-build stand-in for
// vision_siglip_gpu.go. SiglipVisionTower.gpu is never set here, so
// denseForward/siglipAttention (vision_siglip.go) always take the CPU
// path. Mirrors bitnet_gpu_stub.go's pattern.
package cortex

import "errors"

// EnableSiglipGPU stub: GPU support was not compiled in. Rebuild with
// `-tags gpu` (Windows, cgo/MinGW gcc, CUDA runtime + cuBLAS DLLs — see
// cortex/compute/cublas_dyn.go) to enable it.
func EnableSiglipGPU(tower *SiglipVisionTower) error {
	return errors.New("vision gpu backend not compiled in (rebuild with -tags gpu)")
}

// DisableSiglipGPU is a no-op stub — nothing was ever enabled.
func DisableSiglipGPU(tower *SiglipVisionTower) {}
