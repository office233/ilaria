//go:build !(gpu && windows)

// nvrtc_stub.go — pure-Go fallback when the binary is built without
// `-tags gpu` on windows. Mirrors cublas_stub.go/cublas_int8_stub.go's
// pattern for the NVRTC/CUDA-driver API split across nvrtc_dyn.go and
// cuda_driver_dyn.go (both tag `gpu && windows`): every exported name
// either file defines is stubbed here so cortex/bitnet_cuda.go (tag
// `gpu`, not `gpu && windows`) still compiles on any OS under
// `-tags gpu`, and fails cleanly at runtime instead of at compile time.
package compute

import (
	"errors"
	"unsafe"
)

var errCUDANotCompiled = errors.New("cuda/nvrtc not compiled in (rebuild with -tags gpu on windows)")

// CompileToPTX stub always errors.
func CompileToPTX(src string) (string, error) {
	return "", errCUDANotCompiled
}

// Module stub — Launch always errors.
type Module struct{}

// Launch stub always errors.
func (m *Module) Launch(name string, grid, block [3]uint32, sharedMemBytes uint32, args *KernelArgs) error {
	return errCUDANotCompiled
}

// CompileKernels stub always errors.
func CompileKernels(src string) (*Module, error) {
	return nil, errCUDANotCompiled
}

// Synchronize stub always errors.
func Synchronize() error { return errCUDANotCompiled }

// DeviceMemInfo stub always errors.
func DeviceMemInfo() (free, total uint64, err error) {
	return 0, 0, errCUDANotCompiled
}

// DeviceBuffer stub.
type DeviceBuffer struct{}

// AllocDevice stub always errors.
func AllocDevice(bytes int) (*DeviceBuffer, error) {
	return nil, errCUDANotCompiled
}

// Free stub is a no-op.
func (b *DeviceBuffer) Free() {}

// Size stub always reports 0.
func (b *DeviceBuffer) Size() int { return 0 }

// CopyFromHost stub always errors.
func (b *DeviceBuffer) CopyFromHost(src unsafe.Pointer, bytes int) error {
	return errCUDANotCompiled
}

// CopyToHost stub always errors.
func (b *DeviceBuffer) CopyToHost(dst unsafe.Pointer, bytes int) error {
	return errCUDANotCompiled
}

// KernelArgs stub — every Add method is a no-op that returns itself, so
// call chains like NewKernelArgs().AddInt32(1).AddFloat32(2) still
// compile.
type KernelArgs struct{}

// NewKernelArgs stub.
func NewKernelArgs() *KernelArgs { return &KernelArgs{} }

// AddDevicePtr stub no-op.
func (a *KernelArgs) AddDevicePtr(b *DeviceBuffer) *KernelArgs { return a }

// AddDevicePtrOffset stub no-op.
func (a *KernelArgs) AddDevicePtrOffset(b *DeviceBuffer, byteOffset int) *KernelArgs { return a }

// AddInt32 stub no-op.
func (a *KernelArgs) AddInt32(v int32) *KernelArgs { return a }

// AddUint32 stub no-op.
func (a *KernelArgs) AddUint32(v uint32) *KernelArgs { return a }

// AddFloat32 stub no-op.
func (a *KernelArgs) AddFloat32(v float32) *KernelArgs { return a }

// AddFloat64 stub no-op.
func (a *KernelArgs) AddFloat64(v float64) *KernelArgs { return a }

// Release stub is a no-op.
func (a *KernelArgs) Release() {}
