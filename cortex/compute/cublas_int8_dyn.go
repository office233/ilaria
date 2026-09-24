//go:build gpu && windows

// cublas_int8_dyn.go — cuBLAS int8 GEMM bridge (build tag: gpu), for the
// BitNet GPU BitLinear backend (see cortex/bitnet_gpu.go).
//
// WHY A SEPARATE FILE/HANDLE FROM cublas_dyn.go
//
// cublas_dyn.go already loads cudart/cublas dynamically and exposes an
// fp32 GEMM (cublasSgemm) plus a resident-weight registry used by
// transformer_gpu.go. This file adds a SECOND, fully self-contained
// dynamic-loading + cuBLAS-handle pair for int8×int8→int32 GEMM
// (cublasGemmEx, CUDA_R_8I inputs / CUDA_R_32I output /
// CUBLAS_COMPUTE_32I) rather than extending cublas_dyn.go, so this file
// never has to touch that one: cgo's per-file C preamble gives each
// "import C" its own translation unit, so the two files' `static` globals
// (handles, function pointers, weight registries) are naturally isolated
// — no shared state, no merge risk. Two cuBLAS handles on the same
// device is normal and cheap (single one-time cublasCreate each).
//
// WHY int8 GEMM MATCHES THE CPU PATH EXACTLY
//
// cortex/bitnet_linear.go's dotTernaryInt8 accumulates ternary{-1,0,1} ×
// int8 products into an int32 sum via conditional add/subtract — exact
// integer arithmetic, no rounding. cuBLAS's int8 IMMA/DP4A path (this
// GPU: Turing sm_75, no tensor cores, but DP4A is supported since
// sm_61) also accumulates int8×int8 products into int32 exactly — same
// terms, same exact sum (integer addition is associative/commutative,
// and values here never approach int32 overflow: worst case ~6912
// terms × 127×1 ≈ 878k, far under 2^31). So GPU and CPU results are
// bit-identical, not merely close — see bitnet_gpu.go's forward() for
// the rescale step that must also preserve the CPU path's exact
// `float32(acc) * xScale * Scale` left-to-right multiply order.
//
// PADDING
//
// cuBLAS's int8 GEMM (CUBLAS_COMPUTE_32I / CUDA_R_8I) requires m, n, k
// and the leading dimensions to be multiples of 4 — the classic IMMA
// alignment restriction. The real BitNet-2B4T shapes already satisfy
// this (EmbedDim=2560, FFNDim=6912, kvDim=640 are all ÷4), but this
// file pads defensively (pad4) on every call/upload so arbitrary shapes
// — including the tiny 3×5×4 correctness test in
// cublas_int8_dyn_test.go, where In=5 is NOT a multiple of 4 — still
// work: padded rows/columns are zero, and a zero term contributes
// nothing to an integer dot product regardless of which side it's on.
//
// Build: CGO_ENABLED=1 go build -tags gpu ./...  (Windows; MinGW gcc, no
// nvcc/MSVC needed — same as cublas_dyn.go, dynamic LoadLibrary/
// GetProcAddress only).

package compute

/*
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>

typedef int (*fn_i8_cudaSetDevice)(int);
typedef int (*fn_i8_cudaMalloc)(void**, size_t);
typedef int (*fn_i8_cudaFree)(void*);
typedef int (*fn_i8_cudaMemcpy)(void*, const void*, size_t, int);
typedef int (*fn_i8_cudaMemGetInfo)(size_t*, size_t*);
typedef int (*fn_i8_cublasCreate)(void**);
typedef int (*fn_i8_cublasDestroy)(void*);
// cublasGemmEx(handle, transa, transb, m, n, k, alpha,
//              A, Atype, lda, B, Btype, ldb, beta, C, Ctype, ldc,
//              computeType, algo) — enums (cublasOperation_t,
// cudaDataType, cublasComputeType_t, cublasGemmAlgo_t) all pass as
// plain `int`, matching how cublas_dyn.go already treats
// cublasOperation_t (NX_OP_N/NX_OP_T) — verified against this machine's
// installed CUDA 13.2 headers (library_types.h, cublas_api.h).
typedef int (*fn_i8_cublasGemmEx)(void*, int, int, int, int, int,
	const void*, const void*, int, int, const void*, int, int,
	const void*, void*, int, int, int, int);

#define NXI8_MEMCPY_H2D 1
#define NXI8_MEMCPY_D2H 2
#define NXI8_OP_N 0
#define NXI8_OP_T 1
#define NXI8_CUDA_R_8I 3
#define NXI8_CUDA_R_32I 10
#define NXI8_COMPUTE_32I 72
#define NXI8_GEMM_DEFAULT (-1)

static HMODULE gi8_cudart = NULL;
static HMODULE gi8_cublas = NULL;
static fn_i8_cudaSetDevice   pi8_cudaSetDevice = NULL;
static fn_i8_cudaMalloc      pi8_cudaMalloc = NULL;
static fn_i8_cudaFree        pi8_cudaFree = NULL;
static fn_i8_cudaMemcpy      pi8_cudaMemcpy = NULL;
static fn_i8_cudaMemGetInfo  pi8_cudaMemGetInfo = NULL;
static fn_i8_cublasCreate    pi8_cublasCreate = NULL;
static fn_i8_cublasDestroy   pi8_cublasDestroy = NULL;
static fn_i8_cublasGemmEx    pi8_cublasGemmEx = NULL;

static void* gi8_handle = NULL;
static int   gi8_inited = 0;

// Reusable device scratch: the activation matrix (int8) and GEMM output
// (int32) per call. Resident weights get their own permanent buffers
// (below) — only these two scratch buffers are grown/reused call to
// call, same idea as cublas_dyn.go's g_bufA/g_bufB/g_bufC.
static int8_t*  gi8_bufAct = NULL;  static size_t gi8_bufAct_bytes = 0;
static int32_t* gi8_bufOut = NULL;  static size_t gi8_bufOut_bytes = 0;

// Resident int8 weight registry. 8192 slots covers the 210 BitLinear
// matrices in the real 2B4T checkpoint many times over.
#define NXI8WT_MAX 8192
static int8_t* gi8_wptr[NXI8WT_MAX];
static size_t  gi8_wcnt[NXI8WT_MAX]; // element count = outPad*inPad (bytes, since int8)

static HMODULE nxi8_load_versioned(const char* base) {
	static const char* suffixes[] = {"13", "12", "11", "120", "110", NULL};
	char name[512];
	HMODULE h;
	int i;
	for (i = 0; suffixes[i] != NULL; i++) {
		wsprintfA(name, "%s64_%s.dll", base, suffixes[i]);
		h = LoadLibraryA(name);
		if (h) return h;
	}
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

static int nxi8_init(int device) {
	if (gi8_inited) return 0;

	gi8_cudart = nxi8_load_versioned("cudart");
	if (!gi8_cudart) return 101;
	gi8_cublas = nxi8_load_versioned("cublas");
	if (!gi8_cublas) return 102;

	pi8_cudaSetDevice  = (fn_i8_cudaSetDevice)  GetProcAddress(gi8_cudart, "cudaSetDevice");
	pi8_cudaMalloc     = (fn_i8_cudaMalloc)     GetProcAddress(gi8_cudart, "cudaMalloc");
	pi8_cudaFree       = (fn_i8_cudaFree)       GetProcAddress(gi8_cudart, "cudaFree");
	pi8_cudaMemcpy     = (fn_i8_cudaMemcpy)     GetProcAddress(gi8_cudart, "cudaMemcpy");
	pi8_cudaMemGetInfo = (fn_i8_cudaMemGetInfo) GetProcAddress(gi8_cudart, "cudaMemGetInfo");
	pi8_cublasCreate   = (fn_i8_cublasCreate)   GetProcAddress(gi8_cublas, "cublasCreate_v2");
	pi8_cublasDestroy  = (fn_i8_cublasDestroy)  GetProcAddress(gi8_cublas, "cublasDestroy_v2");
	pi8_cublasGemmEx   = (fn_i8_cublasGemmEx)   GetProcAddress(gi8_cublas, "cublasGemmEx");
	if (!pi8_cudaSetDevice || !pi8_cudaMalloc || !pi8_cudaFree || !pi8_cudaMemcpy ||
		!pi8_cudaMemGetInfo || !pi8_cublasCreate || !pi8_cublasDestroy || !pi8_cublasGemmEx) return 103;

	if (pi8_cudaSetDevice(device) != 0) return 104;
	if (pi8_cublasCreate(&gi8_handle) != 0) return 105;
	gi8_inited = 1;
	return 0;
}

static void nxi8_close(void) {
	int i;
	if (!gi8_inited) return;
	if (gi8_bufAct) { pi8_cudaFree(gi8_bufAct); gi8_bufAct = NULL; gi8_bufAct_bytes = 0; }
	if (gi8_bufOut) { pi8_cudaFree(gi8_bufOut); gi8_bufOut = NULL; gi8_bufOut_bytes = 0; }
	for (i = 0; i < NXI8WT_MAX; i++) {
		if (gi8_wptr[i]) { pi8_cudaFree(gi8_wptr[i]); gi8_wptr[i] = NULL; gi8_wcnt[i] = 0; }
	}
	if (gi8_handle) { pi8_cublasDestroy(gi8_handle); gi8_handle = NULL; }
	gi8_inited = 0;
}

static int nxi8_ensure_act(size_t need) {
	if (gi8_bufAct_bytes >= need) return 0;
	if (gi8_bufAct) pi8_cudaFree(gi8_bufAct);
	gi8_bufAct = NULL; gi8_bufAct_bytes = 0;
	if (pi8_cudaMalloc((void**)&gi8_bufAct, need) != 0) return 1;
	gi8_bufAct_bytes = need;
	return 0;
}

static int nxi8_ensure_out(size_t need) {
	if (gi8_bufOut_bytes >= need) return 0;
	if (gi8_bufOut) pi8_cudaFree(gi8_bufOut);
	gi8_bufOut = NULL; gi8_bufOut_bytes = 0;
	if (pi8_cudaMalloc((void**)&gi8_bufOut, need) != 0) return 1;
	gi8_bufOut_bytes = need;
	return 0;
}

static int nxi8_upload_weight(const int8_t* data, int64_t count) {
	int i;
	int8_t* dev = NULL;
	size_t bytes;
	if (!gi8_inited) return -1;
	if (!data || count <= 0) return -2;
	bytes = (size_t)count;
	if (pi8_cudaMalloc((void**)&dev, bytes) != 0) return -3;
	if (pi8_cudaMemcpy(dev, data, bytes, NXI8_MEMCPY_H2D) != 0) { pi8_cudaFree(dev); return -4; }
	for (i = 0; i < NXI8WT_MAX; i++) {
		if (gi8_wptr[i] == NULL) {
			gi8_wptr[i] = dev;
			gi8_wcnt[i] = (size_t)count;
			return i;
		}
	}
	pi8_cudaFree(dev);
	return -5;
}

static void nxi8_free_weight(int h) {
	if (h < 0 || h >= NXI8WT_MAX) return;
	if (gi8_wptr[h]) { pi8_cudaFree(gi8_wptr[h]); gi8_wptr[h] = NULL; gi8_wcnt[h] = 0; }
}

// Y[Mpad,Npad] int32 row-major = X[Mpad,Kpad] int8 x W_resident[Npad,Kpad]^T int8.
// Column-major mapping mirrors cublas_dyn.go's nx_dyn_sgemm_nt exactly
// (transa=T on the weight arg with lda=Kpad, transb=N on the activation
// arg with ldb=Kpad, m=Npad, n=Mpad, ldc=Npad), generalized from
// cublasSgemm to cublasGemmEx with int8 in / int32 out / int32 compute.
static int nxi8_gemm_nt(int h, const int8_t* act, int32_t* out, int Mpad, int Npad, int Kpad) {
	const int32_t alpha = 1, beta = 0;
	size_t bAct, bOut;
	int st;
	if (!gi8_inited) return -1;
	if (Mpad <= 0 || Npad <= 0 || Kpad <= 0) return -2;
	if (h < 0 || h >= NXI8WT_MAX || gi8_wptr[h] == NULL) return -5;
	if (gi8_wcnt[h] != (size_t)Npad * (size_t)Kpad) return -6;
	bAct = (size_t)Mpad * (size_t)Kpad;
	bOut = (size_t)Mpad * (size_t)Npad * 4;
	if (nxi8_ensure_act(bAct)) return 10;
	if (nxi8_ensure_out(bOut)) return 12;
	if (pi8_cudaMemcpy(gi8_bufAct, act, bAct, NXI8_MEMCPY_H2D) != 0) return 20;
	st = pi8_cublasGemmEx(gi8_handle, NXI8_OP_T, NXI8_OP_N, Npad, Mpad, Kpad,
		&alpha,
		gi8_wptr[h], NXI8_CUDA_R_8I, Kpad,
		gi8_bufAct,  NXI8_CUDA_R_8I, Kpad,
		&beta,
		gi8_bufOut, NXI8_CUDA_R_32I, Npad,
		NXI8_COMPUTE_32I, NXI8_GEMM_DEFAULT);
	if (st != 0) return 30;
	if (pi8_cudaMemcpy(out, gi8_bufOut, bOut, NXI8_MEMCPY_D2H) != 0) return 40;
	return 0;
}

static int nxi8_meminfo(size_t* freeBytes, size_t* totalBytes) {
	if (!gi8_inited) return -1;
	return pi8_cudaMemGetInfo(freeBytes, totalBytes);
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
	int8Mu        sync.Mutex
	int8Ready     atomic.Bool
	int8InitOnce  sync.Once
	int8InitError error
)

// pad4 rounds n up to the next multiple of 4 — the cuBLAS int8/IMMA GEMM
// alignment requirement for m, n, k and every leading dimension.
func pad4(n int) int { return (n + 3) &^ 3 }

// InitCuBLASInt8 loads the CUDA runtime + cuBLAS DLLs and creates a
// second cuBLAS handle (independent of cublas_dyn.go's) dedicated to
// int8 GEMM. Idempotent; returns the first attempt's result forever
// after.
func InitCuBLASInt8() error {
	int8InitOnce.Do(func() {
		ret := C.nxi8_init(C.int(0))
		if ret != 0 {
			int8InitError = fmt.Errorf("cuda int8 dynamic init failed (code %d — is the CUDA toolkit/driver installed?)", int(ret))
			return
		}
		int8Ready.Store(true)
	})
	return int8InitError
}

// CloseCuBLASInt8 frees every resident int8 weight, scratch buffer, and
// the int8 cuBLAS handle.
func CloseCuBLASInt8() {
	int8Mu.Lock()
	defer int8Mu.Unlock()
	if !int8Ready.Load() {
		return
	}
	C.nxi8_close()
	int8Ready.Store(false)
}

// IsCuBLASInt8Available reports whether the int8 GEMM backend is ready.
func IsCuBLASInt8Available() bool { return int8Ready.Load() }

// UploadInt8Weight uploads a ternary weight matrix (values in {-1,0,1}),
// logically Out x In row-major, to the device once. Out and In are
// padded up to multiples of 4 (zero rows/columns) before upload — see
// the file doc comment's "PADDING" section — and the returned handle's
// device buffer is pad4(Out)*pad4(In) bytes.
func UploadInt8Weight(data []int8, out, in int) (int, error) {
	if !int8Ready.Load() {
		return -1, errors.New("cublas int8 not initialised")
	}
	if out <= 0 || in <= 0 || len(data) != out*in {
		return -1, fmt.Errorf("dim mismatch len(data)=%d out=%d in=%d", len(data), out, in)
	}
	outPad, inPad := pad4(out), pad4(in)
	padded := data
	if outPad != out || inPad != in {
		padded = make([]int8, outPad*inPad)
		for r := 0; r < out; r++ {
			copy(padded[r*inPad:r*inPad+in], data[r*in:(r+1)*in])
		}
	}
	int8Mu.Lock()
	h := C.nxi8_upload_weight((*C.int8_t)(unsafe.Pointer(&padded[0])), C.int64_t(len(padded)))
	int8Mu.Unlock()
	if h < 0 {
		return -1, fmt.Errorf("dyn upload int8 weight returned %d", int(h))
	}
	return int(h), nil
}

// FreeInt8Weight releases one resident int8 weight; safe on bad handles.
func FreeInt8Weight(handle int) {
	if !int8Ready.Load() {
		return
	}
	int8Mu.Lock()
	C.nxi8_free_weight(C.int(handle))
	int8Mu.Unlock()
}

// MatMulInt8NT computes Y[T,Out] (int32) = X[T,In] (int8) x
// W_resident[Out,In]^T, where W_resident is the weight previously
// uploaded via UploadInt8Weight with these same (out,in) dims. T/Out/In
// are padded internally to multiples of 4 (see file doc comment); only
// the real T*out result values are returned, in row-major [T][Out]
// order.
func MatMulInt8NT(handle int, act []int8, T, out, in int) ([]int32, error) {
	if !int8Ready.Load() {
		return nil, errors.New("cublas int8 not initialised")
	}
	if T <= 0 || out <= 0 || in <= 0 || len(act) != T*in {
		return nil, fmt.Errorf("dim mismatch len(act)=%d T=%d out=%d in=%d", len(act), T, out, in)
	}
	Tpad, outPad, inPad := pad4(T), pad4(out), pad4(in)

	actPad := act
	if Tpad != T || inPad != in {
		actPad = make([]int8, Tpad*inPad)
		for r := 0; r < T; r++ {
			copy(actPad[r*inPad:r*inPad+in], act[r*in:(r+1)*in])
		}
	}
	outPadBuf := make([]int32, Tpad*outPad)

	int8Mu.Lock()
	ret := C.nxi8_gemm_nt(C.int(handle),
		(*C.int8_t)(unsafe.Pointer(&actPad[0])),
		(*C.int32_t)(unsafe.Pointer(&outPadBuf[0])),
		C.int(Tpad), C.int(outPad), C.int(inPad))
	int8Mu.Unlock()
	if ret != 0 {
		return nil, fmt.Errorf("dyn gemm_nt int8 returned %d", int(ret))
	}

	if Tpad == T && outPad == out {
		return outPadBuf, nil
	}
	result := make([]int32, T*out)
	for r := 0; r < T; r++ {
		copy(result[r*out:(r+1)*out], outPadBuf[r*outPad:r*outPad+out])
	}
	return result, nil
}

// MemInfoInt8 returns free/total device memory in bytes (cudaMemGetInfo)
// — used to report GPU memory used after EnableBitNetGPU uploads every
// weight.
func MemInfoInt8() (free, total uint64, err error) {
	if !int8Ready.Load() {
		return 0, 0, errors.New("cublas int8 not initialised")
	}
	var f, tot C.size_t
	int8Mu.Lock()
	ret := C.nxi8_meminfo(&f, &tot)
	int8Mu.Unlock()
	if ret != 0 {
		return 0, 0, fmt.Errorf("cudaMemGetInfo returned %d", int(ret))
	}
	return uint64(f), uint64(tot), nil
}
