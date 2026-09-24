//go:build !(gpu && windows)

// cublas_int8_stub.go — pure-Go fallback when the binary is built
// without `-tags gpu` on windows. Mirrors cublas_stub.go's pattern for
// the int8 GEMM API (cublas_int8_dyn.go): every entry point is a no-op
// or sentinel error so cortex/bitnet_gpu.go's EnableBitNetGPU fails
// cleanly and callers stay on the CPU BitLinear path.

package compute

import "errors"

var errInt8NotCompiled = errors.New("cublas int8 not compiled in (rebuild with -tags gpu on windows)")

// InitCuBLASInt8 stub always errors.
func InitCuBLASInt8() error { return errInt8NotCompiled }

// CloseCuBLASInt8 is a no-op stub.
func CloseCuBLASInt8() {}

// IsCuBLASInt8Available always reports false in stub builds.
func IsCuBLASInt8Available() bool { return false }

// UploadInt8Weight stub always errors.
func UploadInt8Weight(data []int8, out, in int) (int, error) {
	return -1, errInt8NotCompiled
}

// FreeInt8Weight stub is a no-op.
func FreeInt8Weight(handle int) {}

// MatMulInt8NT stub always errors.
func MatMulInt8NT(handle int, act []int8, T, out, in int) ([]int32, error) {
	return nil, errInt8NotCompiled
}

// MemInfoInt8 stub always errors.
func MemInfoInt8() (free, total uint64, err error) {
	return 0, 0, errInt8NotCompiled
}
