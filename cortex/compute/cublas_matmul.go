//go:build cuda && !gpu

// cublas_matmul.go — Go-side cuBLAS dense float32 matmul bridge.
//
// Exposes three things:
//
//   InitCuBLAS()  — call once at process startup. Returns nil if a GPU
//                   was successfully grabbed; non-nil error otherwise.
//                   Safe to call multiple times (idempotent).
//   CloseCuBLAS() — release the GPU handle. Call at shutdown.
//   IsCuBLASAvailable() bool — returns true once Init has succeeded.
//   MatMulGPU(A, B)   — row-major C[M,N] = A[M,K] * B[K,N].
//   MatMulNTGPU(A, B) — row-major C[M,N] = A[M,K] * B[N,K]^T.
//
// The cuBLAS handle is process-global and NOT thread-safe. We serialise
// every GPU call with a single sync.Mutex. That is fine because the
// Broca 2.0 trainer is single-stream: even when goroutines parallelise
// row-slabs of a matmul, the row-slab parallelism is bypassed when GPU
// is active (one big sgemm replaces N small ones).

package compute

/*
#cgo CFLAGS: -I${SRCDIR}/cuda
#cgo LDFLAGS: -L${SRCDIR}/cuda -lcuda_nexus
#include "cuda_bridge.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"
)

var (
	cublasMu        sync.Mutex  // serialises every cuBLAS call (handle is non-reentrant)
	cublasReady     atomic.Bool // true once init succeeded
	cublasInitOnce  sync.Once
	cublasInitError error
)

// InitCuBLAS grabs device 0 and creates a cuBLAS handle. Idempotent:
// repeated calls return the result of the first attempt.
func InitCuBLAS() error {
	cublasInitOnce.Do(func() {
		ret := C.nexus_cublas_init(C.int(0))
		if ret != 0 {
			cublasInitError = fmt.Errorf("nexus_cublas_init returned %d", int(ret))
			return
		}
		cublasReady.Store(true)
	})
	return cublasInitError
}

// CloseCuBLAS releases the handle. After this, IsCuBLASAvailable returns
// false until a fresh process re-inits.
func CloseCuBLAS() {
	cublasMu.Lock()
	defer cublasMu.Unlock()
	if !cublasReady.Load() {
		return
	}
	C.nexus_cublas_close()
	cublasReady.Store(false)
}

// IsCuBLASAvailable reports whether GPU matmul is ready to use.
func IsCuBLASAvailable() bool {
	return cublasReady.Load()
}

// MatMulGPU computes C[M,N] = A[M,K] * B[K,N] in row-major layout.
// A must have len M*K, B must have len K*N, returned slice has len M*N.
func MatMulGPU(A, B []float32, M, N, K int) ([]float32, error) {
	if !cublasReady.Load() {
		return nil, errors.New("cublas not initialised")
	}
	if M <= 0 || N <= 0 || K <= 0 {
		return nil, fmt.Errorf("invalid dims M=%d N=%d K=%d", M, N, K)
	}
	if len(A) != M*K {
		return nil, fmt.Errorf("A length %d != M*K=%d", len(A), M*K)
	}
	if len(B) != K*N {
		return nil, fmt.Errorf("B length %d != K*N=%d", len(B), K*N)
	}
	C_ := make([]float32, M*N)

	cublasMu.Lock()
	ret := C.nexus_cublas_sgemm(
		(*C.float)(unsafe.Pointer(&A[0])),
		(*C.float)(unsafe.Pointer(&B[0])),
		(*C.float)(unsafe.Pointer(&C_[0])),
		C.int(M), C.int(N), C.int(K),
	)
	cublasMu.Unlock()

	if ret != 0 {
		return nil, fmt.Errorf("nexus_cublas_sgemm returned %d", int(ret))
	}
	return C_, nil
}

// UploadWeight copies a weight matrix to the GPU once and returns a
// handle for MatMulResident. The host slice may be reused afterwards.
func UploadWeight(data []float32) (int, error) {
	if !cublasReady.Load() {
		return -1, errors.New("cublas not initialised")
	}
	if len(data) == 0 {
		return -1, errors.New("empty weight")
	}
	cublasMu.Lock()
	h := C.nexus_cublas_upload_weight(
		(*C.float)(unsafe.Pointer(&data[0])),
		C.int64_t(len(data)),
	)
	cublasMu.Unlock()
	if h < 0 {
		return -1, fmt.Errorf("nexus_cublas_upload_weight returned %d", int(h))
	}
	return int(h), nil
}

// FreeWeight releases one uploaded weight. Safe on invalid handles.
func FreeWeight(handle int) {
	if !cublasReady.Load() {
		return
	}
	cublasMu.Lock()
	C.nexus_cublas_free_weight(C.int(handle))
	cublasMu.Unlock()
}

// MatMulResident computes Y[M,N] = X[M,K] × W (transW=false, W resident
// [K,N]) or Y = X × W^T (transW=true, W resident [N,K]) into out, which
// must have len M*N. Only X and Y cross PCIe — this is what makes
// GEMV-bound token generation viable on the GPU.
func MatMulResident(handle int, X []float32, M, N, K int, transW bool, out []float32) error {
	if !cublasReady.Load() {
		return errors.New("cublas not initialised")
	}
	if M <= 0 || N <= 0 || K <= 0 {
		return fmt.Errorf("invalid dims M=%d N=%d K=%d", M, N, K)
	}
	if len(X) != M*K {
		return fmt.Errorf("X length %d != M*K=%d", len(X), M*K)
	}
	if len(out) != M*N {
		return fmt.Errorf("out length %d != M*N=%d", len(out), M*N)
	}
	t := 0
	if transW {
		t = 1
	}
	cublasMu.Lock()
	ret := C.nexus_cublas_sgemm_resident(
		C.int(handle),
		(*C.float)(unsafe.Pointer(&X[0])),
		(*C.float)(unsafe.Pointer(&out[0])),
		C.int(M), C.int(N), C.int(K), C.int(t),
	)
	cublasMu.Unlock()
	if ret != 0 {
		return fmt.Errorf("nexus_cublas_sgemm_resident returned %d", int(ret))
	}
	return nil
}

// MatMulNTGPU computes C[M,N] = A[M,K] * B[N,K]^T in row-major layout.
// Equivalent to Tensor.MatMulTransposed on CPU.
func MatMulNTGPU(A, B []float32, M, N, K int) ([]float32, error) {
	if !cublasReady.Load() {
		return nil, errors.New("cublas not initialised")
	}
	if M <= 0 || N <= 0 || K <= 0 {
		return nil, fmt.Errorf("invalid dims M=%d N=%d K=%d", M, N, K)
	}
	if len(A) != M*K {
		return nil, fmt.Errorf("A length %d != M*K=%d", len(A), M*K)
	}
	if len(B) != N*K {
		return nil, fmt.Errorf("B length %d != N*K=%d", len(B), N*K)
	}
	C_ := make([]float32, M*N)

	cublasMu.Lock()
	ret := C.nexus_cublas_sgemm_nt(
		(*C.float)(unsafe.Pointer(&A[0])),
		(*C.float)(unsafe.Pointer(&B[0])),
		(*C.float)(unsafe.Pointer(&C_[0])),
		C.int(M), C.int(N), C.int(K),
	)
	cublasMu.Unlock()

	if ret != 0 {
		return nil, fmt.Errorf("nexus_cublas_sgemm_nt returned %d", int(ret))
	}
	return C_, nil
}
