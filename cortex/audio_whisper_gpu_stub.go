//go:build !gpu

// audio_whisper_gpu_stub.go — default-build stand-in for
// audio_whisper_gpu.go. WhisperEncoderTower.gpu is never set here, so
// conv1dGeluForward/whisperAttention/whisperMLP (audio_whisper.go)
// always take the CPU path. Mirrors vision_siglip_gpu_stub.go's pattern.
package cortex

import "errors"

// EnableWhisperGPU stub: GPU support was not compiled in. Rebuild with
// `-tags gpu` (Windows, cgo/MinGW gcc, CUDA runtime + cuBLAS DLLs — see
// cortex/compute/cublas_dyn.go) to enable it.
func EnableWhisperGPU(tower *WhisperEncoderTower) error {
	return errors.New("audio gpu backend not compiled in (rebuild with -tags gpu)")
}

// DisableWhisperGPU is a no-op stub — nothing was ever enabled.
func DisableWhisperGPU(tower *WhisperEncoderTower) {}
