//go:build gpu && windows

// cublas_dyn.go — cuBLAS bridge via runtime DLL loading (build tag: gpu).
//
// WHY THIS EXISTS
//
// The static bridge (cublas_matmul.go, tag `cuda`) links against
// cuda_nexus.dll, which must be compiled with nvcc — and nvcc on
// Windows refuses to work without the MSVC toolchain. This machine has
// the CUDA *runtime* (installed with the toolkit/driver) but no MSVC.
//
// The dense-matmul path needs no custom kernels at all — only cuBLAS
// API calls. So this file loads cudart64_*.dll and cublas64_*.dll at
// runtime via LoadLibrary/GetProcAddress from a small C shim that cgo
// compiles with MinGW gcc. No nvcc, no import libraries, no DLL
// co-location trap (HARDCODING_AND_LIMITATIONS.md §10) — the CUDA DLLs
// come from the toolkit's own bin directory or PATH.
//
// Exposes the exact same Go API as the static bridge, so callers are
// oblivious: InitCuBLAS, CloseCuBLAS, IsCuBLASAvailable, MatMulGPU,
// MatMulNTGPU, UploadWeight, FreeWeight, MatMulResident.
//
// Build: go build -tags gpu ./...   (mutually exclusive with -tags cuda)

package compute

/*
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>

// ─── Minimal CUDA/cuBLAS ABI declarations ───────────────────────────
// x64 Windows has a single calling convention, and these signatures
// have been ABI-stable across every CUDA release we care about, which
// is what makes header-free dynamic loading safe.

typedef int (*fn_cudaSetDevice)(int);
typedef int (*fn_cudaMalloc)(void**, size_t);
typedef int (*fn_cudaFree)(void*);
typedef int (*fn_cudaMemcpy)(void*, const void*, size_t, int);
typedef int (*fn_cublasCreate)(void**);
typedef int (*fn_cublasDestroy)(void*);
typedef int (*fn_cublasSgemm)(void*, int, int, int, int, int,
	const float*, const float*, int, const float*, int,
	const float*, float*, int);

#define NX_MEMCPY_H2D 1
#define NX_MEMCPY_D2H 2
#define NX_OP_N 0
#define NX_OP_T 1

static HMODULE g_cudart = NULL;
static HMODULE g_cublas = NULL;
static fn_cudaSetDevice  p_cudaSetDevice = NULL;
static fn_cudaMalloc     p_cudaMalloc = NULL;
static fn_cudaFree       p_cudaFree = NULL;
static fn_cudaMemcpy     p_cudaMemcpy = NULL;
static fn_cublasCreate   p_cublasCreate = NULL;
static fn_cublasDestroy  p_cublasDestroy = NULL;
static fn_cublasSgemm    p_cublasSgemm = NULL;

static void* g_handle = NULL;
static int   g_inited = 0;

// Reusable device buffers for activations/results (same arena idea as
// the static bridge: cudaMalloc costs ~100us on Windows, a GEMV ~50us).
static float* g_bufA = NULL; static size_t g_bufA_bytes = 0;
static float* g_bufB = NULL; static size_t g_bufB_bytes = 0;
static float* g_bufC = NULL; static size_t g_bufC_bytes = 0;

// Resident weight registry. Fixed table: 8192 slots is two orders of
// magnitude above what a GPT-2-class model needs (6 per block + 1).
#define NXWT_MAX 8192
static float*  g_wptr[NXWT_MAX];
static size_t  g_wcnt[NXWT_MAX];

static HMODULE nx_load_versioned(const char* base) {
	// Try bare name first (PATH / already-loaded), then CUDA_PATH\bin,
	// then a spread of recent version suffixes.
	static const char* suffixes[] = {"13", "12", "11", "120", "110", NULL};
	char name[512];
	HMODULE h;
	int i;
	for (i = 0; suffixes[i] != NULL; i++) {
		wsprintfA(name, "%s64_%s.dll", base, suffixes[i]);
		h = LoadLibraryA(name);
		if (h) return h;
	}
	// CUDA_PATH fallback with explicit directory.
	{
		char cudaPath[400];
		DWORD n = GetEnvironmentVariableA("CUDA_PATH", cudaPath, sizeof(cudaPath));
		if (n > 0 && n < sizeof(cudaPath)) {
			for (i = 0; suffixes[i] != NULL; i++) {
				wsprintfA(name, "%s\\bin\\%s64_%s.dll", cudaPath, base, suffixes[i]);
				h = LoadLibraryA(name);
				if (h) return h;
				wsprintfA(name, "%s\\bin\\x64\\%s64_%s.dll", cudaPath, base, suffixes[i]);
				h = LoadLibraryA(name);
				if (h) return h;
			}
		}
	}
	return NULL;
}

static int nx_dyn_init(int device) {
	if (g_inited) return 0;

	g_cudart = nx_load_versioned("cudart");
	if (!g_cudart) return 101;
	g_cublas = nx_load_versioned("cublas");
	if (!g_cublas) return 102;

	p_cudaSetDevice = (fn_cudaSetDevice)GetProcAddress(g_cudart, "cudaSetDevice");
	p_cudaMalloc    = (fn_cudaMalloc)   GetProcAddress(g_cudart, "cudaMalloc");
	p_cudaFree      = (fn_cudaFree)     GetProcAddress(g_cudart, "cudaFree");
	p_cudaMemcpy    = (fn_cudaMemcpy)   GetProcAddress(g_cudart, "cudaMemcpy");
	p_cublasCreate  = (fn_cublasCreate) GetProcAddress(g_cublas, "cublasCreate_v2");
	p_cublasDestroy = (fn_cublasDestroy)GetProcAddress(g_cublas, "cublasDestroy_v2");
	p_cublasSgemm   = (fn_cublasSgemm)  GetProcAddress(g_cublas, "cublasSgemm_v2");
	if (!p_cudaSetDevice || !p_cudaMalloc || !p_cudaFree || !p_cudaMemcpy ||
		!p_cublasCreate || !p_cublasDestroy || !p_cublasSgemm) return 103;

	if (p_cudaSetDevice(device) != 0) return 104;
	if (p_cublasCreate(&g_handle) != 0) return 105;
	g_inited = 1;
	return 0;
}

static void nx_free_buf(float** p, size_t* bytes) {
	if (*p) p_cudaFree(*p);
	*p = NULL;
	*bytes = 0;
}

static int nx_ensure_buf(float** p, size_t* have, size_t need) {
	if (*have >= need) return 0;
	if (*p) p_cudaFree(*p);
	*p = NULL;
	*have = 0;
	if (p_cudaMalloc((void**)p, need) != 0) return 1;
	*have = need;
	return 0;
}

static void nx_dyn_close(void) {
	int i;
	if (!g_inited) return;
	nx_free_buf(&g_bufA, &g_bufA_bytes);
	nx_free_buf(&g_bufB, &g_bufB_bytes);
	nx_free_buf(&g_bufC, &g_bufC_bytes);
	for (i = 0; i < NXWT_MAX; i++) {
		if (g_wptr[i]) { p_cudaFree(g_wptr[i]); g_wptr[i] = NULL; g_wcnt[i] = 0; }
	}
	if (g_handle) { p_cublasDestroy(g_handle); g_handle = NULL; }
	g_inited = 0;
}

// Row-major C[M,N] = A[M,K] × B[K,N]: column-major C[N,M] = B_col[N,K] × A_col[K,M].
static int nx_dyn_sgemm(const float* A, const float* B, float* C, int M, int N, int K) {
	const float alpha = 1.0f, beta = 0.0f;
	size_t bA = (size_t)M * K * 4, bB = (size_t)K * N * 4, bC = (size_t)M * N * 4;
	if (!g_inited) return -1;
	if (M <= 0 || N <= 0 || K <= 0) return -2;
	if (nx_ensure_buf(&g_bufA, &g_bufA_bytes, bA)) return 10;
	if (nx_ensure_buf(&g_bufB, &g_bufB_bytes, bB)) return 11;
	if (nx_ensure_buf(&g_bufC, &g_bufC_bytes, bC)) return 12;
	if (p_cudaMemcpy(g_bufA, A, bA, NX_MEMCPY_H2D) != 0) return 20;
	if (p_cudaMemcpy(g_bufB, B, bB, NX_MEMCPY_H2D) != 0) return 21;
	if (p_cublasSgemm(g_handle, NX_OP_N, NX_OP_N, N, M, K,
		&alpha, g_bufB, N, g_bufA, K, &beta, g_bufC, N) != 0) return 30;
	if (p_cudaMemcpy(C, g_bufC, bC, NX_MEMCPY_D2H) != 0) return 40;
	return 0;
}

// Row-major C[M,N] = A[M,K] × B[N,K]^T (same trick as the static bridge).
static int nx_dyn_sgemm_nt(const float* A, const float* B, float* C, int M, int N, int K) {
	const float alpha = 1.0f, beta = 0.0f;
	size_t bA = (size_t)M * K * 4, bB = (size_t)N * K * 4, bC = (size_t)M * N * 4;
	if (!g_inited) return -1;
	if (M <= 0 || N <= 0 || K <= 0) return -2;
	if (nx_ensure_buf(&g_bufA, &g_bufA_bytes, bA)) return 10;
	if (nx_ensure_buf(&g_bufB, &g_bufB_bytes, bB)) return 11;
	if (nx_ensure_buf(&g_bufC, &g_bufC_bytes, bC)) return 12;
	if (p_cudaMemcpy(g_bufA, A, bA, NX_MEMCPY_H2D) != 0) return 20;
	if (p_cudaMemcpy(g_bufB, B, bB, NX_MEMCPY_H2D) != 0) return 21;
	if (p_cublasSgemm(g_handle, NX_OP_T, NX_OP_N, N, M, K,
		&alpha, g_bufB, K, g_bufA, K, &beta, g_bufC, N) != 0) return 30;
	if (p_cudaMemcpy(C, g_bufC, bC, NX_MEMCPY_D2H) != 0) return 40;
	return 0;
}

static int nx_dyn_upload(const float* data, int64_t count) {
	int i;
	float* dev = NULL;
	size_t bytes;
	if (!g_inited) return -1;
	if (!data || count <= 0) return -2;
	bytes = (size_t)count * 4;
	if (p_cudaMalloc((void**)&dev, bytes) != 0) return -3;
	if (p_cudaMemcpy(dev, data, bytes, NX_MEMCPY_H2D) != 0) { p_cudaFree(dev); return -4; }
	for (i = 0; i < NXWT_MAX; i++) {
		if (g_wptr[i] == NULL) {
			g_wptr[i] = dev;
			g_wcnt[i] = (size_t)count;
			return i;
		}
	}
	p_cudaFree(dev);
	return -5;
}

static void nx_dyn_free_weight(int h) {
	if (h < 0 || h >= NXWT_MAX) return;
	if (g_wptr[h]) { p_cudaFree(g_wptr[h]); g_wptr[h] = NULL; g_wcnt[h] = 0; }
}

// Y[M,N] = X[M,K] × W (resident; transW selects W[K,N] vs W[N,K]^T).
static int nx_dyn_sgemm_resident(int h, const float* X, float* Y,
	int M, int N, int K, int transW) {
	const float alpha = 1.0f, beta = 0.0f;
	size_t bX = (size_t)M * K * 4, bY = (size_t)M * N * 4;
	int st;
	if (!g_inited) return -1;
	if (M <= 0 || N <= 0 || K <= 0) return -2;
	if (h < 0 || h >= NXWT_MAX || g_wptr[h] == NULL) return -5;
	if (g_wcnt[h] < (size_t)N * K) return -6;
	if (nx_ensure_buf(&g_bufA, &g_bufA_bytes, bX)) return 10;
	if (nx_ensure_buf(&g_bufC, &g_bufC_bytes, bY)) return 12;
	if (p_cudaMemcpy(g_bufA, X, bX, NX_MEMCPY_H2D) != 0) return 20;
	if (transW == 0) {
		st = p_cublasSgemm(g_handle, NX_OP_N, NX_OP_N, N, M, K,
			&alpha, g_wptr[h], N, g_bufA, K, &beta, g_bufC, N);
	} else {
		st = p_cublasSgemm(g_handle, NX_OP_T, NX_OP_N, N, M, K,
			&alpha, g_wptr[h], K, g_bufA, K, &beta, g_bufC, N);
	}
	if (st != 0) return 30;
	if (p_cudaMemcpy(Y, g_bufC, bY, NX_MEMCPY_D2H) != 0) return 40;
	return 0;
}
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
	cublasMu        sync.Mutex
	cublasReady     atomic.Bool
	cublasInitOnce  sync.Once
	cublasInitError error
)

// InitCuBLAS loads the CUDA runtime + cuBLAS DLLs and grabs device 0.
// Idempotent; returns the first attempt's result forever after.
func InitCuBLAS() error {
	cublasInitOnce.Do(func() {
		ret := C.nx_dyn_init(C.int(0))
		if ret != 0 {
			cublasInitError = fmt.Errorf("cuda dynamic init failed (code %d — is the CUDA toolkit/driver installed?)", int(ret))
			return
		}
		cublasReady.Store(true)
	})
	return cublasInitError
}

// CloseCuBLAS frees device memory and the cuBLAS handle.
func CloseCuBLAS() {
	cublasMu.Lock()
	defer cublasMu.Unlock()
	if !cublasReady.Load() {
		return
	}
	C.nx_dyn_close()
	cublasReady.Store(false)
}

// IsCuBLASAvailable reports whether GPU matmul is ready.
func IsCuBLASAvailable() bool { return cublasReady.Load() }

// MatMulGPU computes C[M,N] = A[M,K] × B[K,N] (row-major).
func MatMulGPU(A, B []float32, M, N, K int) ([]float32, error) {
	if !cublasReady.Load() {
		return nil, errors.New("cublas not initialised")
	}
	if len(A) != M*K || len(B) != K*N {
		return nil, fmt.Errorf("dim mismatch A=%d B=%d M=%d N=%d K=%d", len(A), len(B), M, N, K)
	}
	out := make([]float32, M*N)
	cublasMu.Lock()
	ret := C.nx_dyn_sgemm(
		(*C.float)(unsafe.Pointer(&A[0])),
		(*C.float)(unsafe.Pointer(&B[0])),
		(*C.float)(unsafe.Pointer(&out[0])),
		C.int(M), C.int(N), C.int(K))
	cublasMu.Unlock()
	if ret != 0 {
		return nil, fmt.Errorf("dyn sgemm returned %d", int(ret))
	}
	return out, nil
}

// MatMulNTGPU computes C[M,N] = A[M,K] × B[N,K]^T (row-major).
func MatMulNTGPU(A, B []float32, M, N, K int) ([]float32, error) {
	if !cublasReady.Load() {
		return nil, errors.New("cublas not initialised")
	}
	if len(A) != M*K || len(B) != N*K {
		return nil, fmt.Errorf("dim mismatch A=%d B=%d M=%d N=%d K=%d", len(A), len(B), M, N, K)
	}
	out := make([]float32, M*N)
	cublasMu.Lock()
	ret := C.nx_dyn_sgemm_nt(
		(*C.float)(unsafe.Pointer(&A[0])),
		(*C.float)(unsafe.Pointer(&B[0])),
		(*C.float)(unsafe.Pointer(&out[0])),
		C.int(M), C.int(N), C.int(K))
	cublasMu.Unlock()
	if ret != 0 {
		return nil, fmt.Errorf("dyn sgemm_nt returned %d", int(ret))
	}
	return out, nil
}

// UploadWeight copies a weight matrix to the device once; see
// MatMulResident for how the handle is used.
func UploadWeight(data []float32) (int, error) {
	if !cublasReady.Load() {
		return -1, errors.New("cublas not initialised")
	}
	if len(data) == 0 {
		return -1, errors.New("empty weight")
	}
	cublasMu.Lock()
	h := C.nx_dyn_upload((*C.float)(unsafe.Pointer(&data[0])), C.int64_t(len(data)))
	cublasMu.Unlock()
	if h < 0 {
		return -1, fmt.Errorf("dyn upload returned %d", int(h))
	}
	return int(h), nil
}

// FreeWeight releases one resident weight; safe on bad handles.
func FreeWeight(handle int) {
	if !cublasReady.Load() {
		return
	}
	cublasMu.Lock()
	C.nx_dyn_free_weight(C.int(handle))
	cublasMu.Unlock()
}

// MatMulResident computes Y[M,N] = X[M,K] × W_resident (or × W^T when
// transW). Only X and Y cross PCIe — the point of weight residency.
func MatMulResident(handle int, X []float32, M, N, K int, transW bool, out []float32) error {
	if !cublasReady.Load() {
		return errors.New("cublas not initialised")
	}
	if len(X) != M*K || len(out) != M*N {
		return fmt.Errorf("dim mismatch X=%d out=%d M=%d N=%d K=%d", len(X), len(out), M, N, K)
	}
	t := 0
	if transW {
		t = 1
	}
	cublasMu.Lock()
	ret := C.nx_dyn_sgemm_resident(
		C.int(handle),
		(*C.float)(unsafe.Pointer(&X[0])),
		(*C.float)(unsafe.Pointer(&out[0])),
		C.int(M), C.int(N), C.int(K), C.int(t))
	cublasMu.Unlock()
	if ret != 0 {
		return fmt.Errorf("dyn sgemm_resident returned %d", int(ret))
	}
	return nil
}
