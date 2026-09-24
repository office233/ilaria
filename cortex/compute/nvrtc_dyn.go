//go:build gpu && windows

// nvrtc_dyn.go — NVRTC bridge via runtime DLL loading (build tag: gpu &&
// windows), the compiler half of the BitNet CUDA decode path.
//
// # WHY THIS EXISTS
//
// The BitNet CUDA decode path (cortex/bitnet_cuda.go) needs custom
// kernels (ternary GEMV, rmsnorm, int8 activation quant, ReLU², RoPE,
// fused attention, fp16 lm_head) that cuBLAS cannot express. Compiling
// them ahead of time would need nvcc, which on this machine (Windows, no
// MSVC) refuses to run. NVRTC — the CUDA runtime-compilation library —
// compiles CUDA C to PTX entirely at process runtime, needs no host
// compiler at all, and (like cublas_dyn.go/cublas_int8_dyn.go) is loaded
// here via LoadLibrary/GetProcAddress from a small C shim cgo compiles
// with MinGW gcc. No nvcc, no import libraries.
//
// This file owns exactly the NVRTC half of the pipeline: turning a CUDA
// C source string into a PTX string (CompileToPTX), with the compiled
// PTX cached on disk (keyed by a hash of the source) so repeat runs skip
// recompilation. cuda_driver_dyn.go owns the other half — loading that
// PTX into a live CUDA context via the driver API (nvcuda.dll) and
// running it — and ties the two together with CompileKernels.
//
// Build: CGO_ENABLED=1 go build -tags gpu ./...  (Windows; MinGW gcc, no
// nvcc/MSVC needed).
package compute

/*
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// ─── Minimal NVRTC ABI declarations ─────────────────────────────────
// x64 Windows has one calling convention, and NVRTC's ABI has been
// stable since its introduction — safe for header-free dynamic loading,
// same reasoning as cublas_dyn.go's declarations.

typedef void* nvrtcProgram;

typedef int (*fn_nvrtcCreateProgram)(nvrtcProgram*, const char*, const char*, int, const char* const*, const char* const*);
typedef int (*fn_nvrtcCompileProgram)(nvrtcProgram, int, const char* const*);
typedef int (*fn_nvrtcGetProgramLogSize)(nvrtcProgram, size_t*);
typedef int (*fn_nvrtcGetProgramLog)(nvrtcProgram, char*);
typedef int (*fn_nvrtcGetPTXSize)(nvrtcProgram, size_t*);
typedef int (*fn_nvrtcGetPTX)(nvrtcProgram, char*);
typedef int (*fn_nvrtcDestroyProgram)(nvrtcProgram*);

static HMODULE            gnv_lib = NULL;
static fn_nvrtcCreateProgram      pnv_CreateProgram = NULL;
static fn_nvrtcCompileProgram     pnv_CompileProgram = NULL;
static fn_nvrtcGetProgramLogSize  pnv_GetProgramLogSize = NULL;
static fn_nvrtcGetProgramLog      pnv_GetProgramLog = NULL;
static fn_nvrtcGetPTXSize         pnv_GetPTXSize = NULL;
static fn_nvrtcGetPTX             pnv_GetPTX = NULL;
static fn_nvrtcDestroyProgram     pnv_DestroyProgram = NULL;

static int gnv_inited = 0;

// nvrtc's DLL name is versioned as nvrtc64_<ver>_0.dll (NOT the plain
// "<base>64_<major>.dll" scheme cudart/cublas use), e.g.
// nvrtc64_130_0.dll for CUDA 13.2, nvrtc64_120_0.dll for CUDA 12.x. Try
// a spread of known suffixes bare (PATH), then hunt CUDA_PATH's bin
// directories with a wildcard match so any version we didn't think to
// list by name is still found.
static HMODULE nv_load_versioned(void) {
	static const char* suffixes[] = {
		"130_0", "129_0", "128_0", "127_0", "126_0", "125_0", "124_0",
		"123_0", "122_0", "121_0", "120_0", "118_0", "117_0", "116_0",
		"112_0", "111_0", "110_0", NULL,
	};
	char name[512];
	HMODULE h;
	int i;
	for (i = 0; suffixes[i] != NULL; i++) {
		wsprintfA(name, "nvrtc64_%s.dll", suffixes[i]);
		h = LoadLibraryA(name);
		if (h) return h;
	}

	{
		char cudaPath[400];
		DWORD n = GetEnvironmentVariableA("CUDA_PATH", cudaPath, sizeof(cudaPath));
		if (n > 0 && n < sizeof(cudaPath)) {
			for (i = 0; suffixes[i] != NULL; i++) {
				wsprintfA(name, "%s\\bin\\x64\\nvrtc64_%s.dll", cudaPath, suffixes[i]);
				h = LoadLibraryA(name);
				if (h) return h;
				wsprintfA(name, "%s\\bin\\nvrtc64_%s.dll", cudaPath, suffixes[i]);
				h = LoadLibraryA(name);
				if (h) return h;
			}
		}
	}

	// Last resort: wildcard-scan CUDA_PATH's bin\x64 (and bin) for
	// anything matching nvrtc64_*.dll, in case the installed version's
	// suffix isn't in the static list above at all.
	{
		char cudaPath[400];
		DWORD n = GetEnvironmentVariableA("CUDA_PATH", cudaPath, sizeof(cudaPath));
		if (n > 0 && n < sizeof(cudaPath)) {
			static const char* subdirs[] = {"\\bin\\x64\\", "\\bin\\", NULL};
			int d;
			for (d = 0; subdirs[d] != NULL; d++) {
				char pattern[512];
				WIN32_FIND_DATAA fd;
				HANDLE fh;
				wsprintfA(pattern, "%s%snvrtc64_*.dll", cudaPath, subdirs[d]);
				fh = FindFirstFileA(pattern, &fd);
				if (fh != INVALID_HANDLE_VALUE) {
					char full[600];
					wsprintfA(full, "%s%s%s", cudaPath, subdirs[d], fd.cFileName);
					FindClose(fh);
					h = LoadLibraryA(full);
					if (h) return h;
				}
			}
		}
	}
	return NULL;
}

static int nv_dyn_init(void) {
	if (gnv_inited) return 0;
	gnv_lib = nv_load_versioned();
	if (!gnv_lib) return 201;

	pnv_CreateProgram     = (fn_nvrtcCreateProgram)     GetProcAddress(gnv_lib, "nvrtcCreateProgram");
	pnv_CompileProgram    = (fn_nvrtcCompileProgram)    GetProcAddress(gnv_lib, "nvrtcCompileProgram");
	pnv_GetProgramLogSize = (fn_nvrtcGetProgramLogSize) GetProcAddress(gnv_lib, "nvrtcGetProgramLogSize");
	pnv_GetProgramLog     = (fn_nvrtcGetProgramLog)     GetProcAddress(gnv_lib, "nvrtcGetProgramLog");
	pnv_GetPTXSize        = (fn_nvrtcGetPTXSize)        GetProcAddress(gnv_lib, "nvrtcGetPTXSize");
	pnv_GetPTX            = (fn_nvrtcGetPTX)            GetProcAddress(gnv_lib, "nvrtcGetPTX");
	pnv_DestroyProgram    = (fn_nvrtcDestroyProgram)    GetProcAddress(gnv_lib, "nvrtcDestroyProgram");
	if (!pnv_CreateProgram || !pnv_CompileProgram || !pnv_GetProgramLogSize ||
		!pnv_GetProgramLog || !pnv_GetPTXSize || !pnv_GetPTX || !pnv_DestroyProgram) {
		return 202;
	}
	gnv_inited = 1;
	return 0;
}

// nv_compile compiles `src` (a null-terminated CUDA C string) targeting
// compute_75 (this machine's GTX 1660 Ti, Turing sm_75) with
// -default-device, and returns 0 on success with *ptxOut/*ptxLen set to
// a malloc'd buffer the Go side must free, or a non-zero nvrtc/internal
// status with *logOut/*logLen set to a malloc'd compile log (also
// caller-freed; may be a zero-length "" on a failure that produced no
// log, e.g. program creation itself failing).
static int nv_compile(const char* src, char** ptxOut, size_t* ptxLen, char** logOut, size_t* logLen) {
	nvrtcProgram prog = NULL;
	int rc;
	*ptxOut = NULL; *ptxLen = 0; *logOut = NULL; *logLen = 0;

	rc = nv_dyn_init();
	if (rc != 0) return rc;

	rc = pnv_CreateProgram(&prog, src, "bitnet_kernels.cu", 0, NULL, NULL);
	if (rc != 0) return 1000 + rc;

	{
		const char* opts[2];
		opts[0] = "--gpu-architecture=compute_75";
		opts[1] = "-default-device";
		rc = pnv_CompileProgram(prog, 2, opts);
	}

	{
		size_t ls = 0;
		if (pnv_GetProgramLogSize(prog, &ls) == 0 && ls > 1) {
			char* log = (char*)malloc(ls);
			if (log) {
				if (pnv_GetProgramLog(prog, log) == 0) {
					*logOut = log;
					*logLen = ls - 1; // ls includes the NUL
				} else {
					free(log);
				}
			}
		}
	}

	if (rc != 0) {
		pnv_DestroyProgram(&prog);
		return 2000 + rc;
	}

	{
		size_t ps = 0;
		char* ptx;
		if (pnv_GetPTXSize(prog, &ps) != 0 || ps == 0) {
			pnv_DestroyProgram(&prog);
			return 300;
		}
		ptx = (char*)malloc(ps);
		if (!ptx) {
			pnv_DestroyProgram(&prog);
			return 301;
		}
		if (pnv_GetPTX(prog, ptx) != 0) {
			free(ptx);
			pnv_DestroyProgram(&prog);
			return 302;
		}
		*ptxOut = ptx;
		*ptxLen = ps - 1; // ps includes the NUL
	}

	pnv_DestroyProgram(&prog);
	return 0;
}
*/
import "C"

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unsafe"
)

var (
	nvrtcMu   sync.Mutex
	nvrtcOnce sync.Once
	nvrtcErr  error
)

// initNVRTC loads nvrtc64_*.dll and resolves every entry point this file
// needs. Idempotent; the first attempt's result is returned forever
// after (same pattern as InitCuBLAS/InitCuBLASInt8).
func initNVRTC() error {
	nvrtcOnce.Do(func() {
		ret := C.nv_dyn_init()
		if ret != 0 {
			nvrtcErr = fmt.Errorf("nvrtc dynamic init failed (code %d — is nvrtc64_*.dll from the CUDA toolkit installed? checked PATH and CUDA_PATH\\bin\\x64)", int(ret))
		}
	})
	return nvrtcErr
}

// ptxCacheDir is where compiled PTX is cached on disk, keyed by a hash
// of the source text — os.TempDir() rather than a project-relative path,
// since compiled kernels are a build artifact of this machine's CUDA
// install/GPU arch, not something to commit or share across machines.
func ptxCacheDir() string {
	return filepath.Join(os.TempDir(), "nexus-nvrtc-cache")
}

// ptxCachePath returns the cache file path for a given source string,
// keyed by its SHA-256 hash so any source edit (including this file's
// own kernel string changing between builds) invalidates the cache
// automatically.
func ptxCachePath(src string) string {
	sum := sha256.Sum256([]byte(src))
	return filepath.Join(ptxCacheDir(), hex.EncodeToString(sum[:])+".ptx")
}

// CompileToPTX compiles CUDA C source `src` to a PTX string targeting
// compute_75 (-default-device set so bare kernel/device functions need
// no explicit __global__/__device__ execution-space gymnastics beyond
// what bitnet_cuda.go's kernel source already uses), consulting an
// on-disk cache first (keyed by sha256(src) under
// os.TempDir()/nexus-nvrtc-cache) so repeated calls with identical
// source — the common case, since the kernel source is a fixed Go
// string constant — skip recompilation entirely after the first run of
// a given binary.
//
// Kernels here must be declared `extern "C" __global__ void name(...)`
// so their names survive into the PTX unmangled — CompileKernels'
// cuModuleGetFunction lookups are by that exact C name.
func CompileToPTX(src string) (string, error) {
	if src == "" {
		return "", errors.New("nvrtc: empty source")
	}

	cachePath := ptxCachePath(src)
	if data, err := os.ReadFile(cachePath); err == nil && len(data) > 0 {
		return string(data), nil
	}

	if err := initNVRTC(); err != nil {
		return "", err
	}

	csrc := C.CString(src)
	defer C.free(unsafe.Pointer(csrc))

	var ptxPtr, logPtr *C.char
	var ptxLen, logLen C.size_t

	nvrtcMu.Lock()
	rc := C.nv_compile(csrc, &ptxPtr, &ptxLen, &logPtr, &logLen)
	nvrtcMu.Unlock()

	var log string
	if logPtr != nil {
		log = C.GoStringN(logPtr, C.int(logLen))
		C.free(unsafe.Pointer(logPtr))
	}

	if rc != 0 {
		if log != "" {
			return "", fmt.Errorf("nvrtc: compile failed (code %d): %s", int(rc), log)
		}
		return "", fmt.Errorf("nvrtc: compile failed (code %d)", int(rc))
	}
	if ptxPtr == nil {
		return "", errors.New("nvrtc: compile reported success but returned no PTX")
	}

	ptx := C.GoStringN(ptxPtr, C.int(ptxLen))
	C.free(unsafe.Pointer(ptxPtr))

	if log != "" {
		// Non-fatal diagnostics (e.g. warnings) on an otherwise
		// successful compile — surfaced by returning them alongside a
		// nil error would break the signature, so they're dropped here;
		// a caller debugging kernel issues can temporarily log rc/log
		// from nv_compile directly. Keeping the common path clean is
		// more valuable than plumbing warning text through every call.
		_ = log
	}

	if err := os.MkdirAll(ptxCacheDir(), 0o755); err == nil {
		_ = os.WriteFile(cachePath, []byte(ptx), 0o644)
	}
	return ptx, nil
}
