//go:build gpu && windows

// cuda_driver_dyn.go — CUDA driver API bridge via runtime DLL loading
// (build tag: gpu && windows), the execution half of the BitNet CUDA
// decode path (see nvrtc_dyn.go's file doc comment for the split between
// the two files and why NVRTC/nvcuda are loaded dynamically at all —
// same reasoning as cublas_dyn.go/cublas_int8_dyn.go: no nvcc/MSVC on
// this machine, only LoadLibrary/GetProcAddress + MinGW-compiled cgo).
//
// This file loads nvcuda.dll (always present in
// C:\Windows\System32 alongside any NVIDIA display driver — no
// CUDA_PATH hunting needed, unlike cudart/cublas/nvrtc, which ship with
// the toolkit rather than the driver), creates and activates one CUDA
// context for device 0 (cuCtxCreate — see nxcu_dyn_init's doc comment
// for why this is a regular context and not the primary context
// cuDevicePrimaryCtxRetain would give), and exposes:
//
//   - CompileKernels(src) (*Module, error) — nvrtc_dyn.go's
//     CompileToPTX(src) followed by cuModuleLoadData, so callers hand
//     over CUDA C source and get back a Module ready to Launch.
//   - Module.Launch(name, grid, block, sharedMem, args) — resolves and
//     caches the CUfunction by name (kernels must be declared
//     `extern "C" __global__` in the source so cuModuleGetFunction can
//     find them unmangled) and calls cuLaunchKernel on the default
//     stream.
//   - DeviceBuffer — cuMemAlloc/cuMemFree-backed device memory, with
//     CopyFromHost/CopyToHost (cuMemcpyHtoD/DtoH) and OffsetPtr for
//     kernels that address a sub-range of a larger resident buffer (the
//     KV cache, addressed per layer/position — see cortex/bitnet_cuda.go).
//   - KernelArgs — builds the void** argument array cuLaunchKernel
//     needs entirely out of C-allocated memory (C.malloc'd slots, a
//     C.malloc'd pointer array), so no Go pointer ever crosses the cgo
//     boundary inside a kernel-parameter buffer — sidesteps cgo's
//     Go-pointer-to-C rules entirely rather than fighting them.
//   - Synchronize / DeviceMemInfo — cuCtxSynchronize / cuMemGetInfo.
//
// Build: CGO_ENABLED=1 go build -tags gpu ./...
package compute

/*
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>

typedef int          CUdevice;
typedef void*         CUcontext;
typedef void*         CUmodule;
typedef void*         CUfunction;
typedef void*         CUstream;
typedef unsigned long long CUdeviceptr;

typedef int (*fn_cuInit)(unsigned int);
typedef int (*fn_cuDeviceGet)(CUdevice*, int);
typedef int (*fn_cuCtxCreate)(CUcontext*, unsigned int, CUdevice);
typedef int (*fn_cuCtxSetCurrent)(CUcontext);
typedef int (*fn_cuModuleLoadData)(CUmodule*, const void*);
typedef int (*fn_cuModuleGetFunction)(CUfunction*, CUmodule, const char*);
typedef int (*fn_cuLaunchKernel)(CUfunction,
	unsigned int, unsigned int, unsigned int,
	unsigned int, unsigned int, unsigned int,
	unsigned int, CUstream, void**, void**);
typedef int (*fn_cuMemAlloc)(CUdeviceptr*, size_t);
typedef int (*fn_cuMemFree)(CUdeviceptr);
typedef int (*fn_cuMemcpyHtoD)(CUdeviceptr, const void*, size_t);
typedef int (*fn_cuMemcpyDtoH)(void*, CUdeviceptr, size_t);
typedef int (*fn_cuCtxSynchronize)(void);
typedef int (*fn_cuMemGetInfo)(size_t*, size_t*);
typedef int (*fn_cuGetErrorString)(int, const char**);

static HMODULE gcu_lib = NULL;
static CUcontext gcu_ctx = NULL;
static fn_cuInit                   pcu_Init = NULL;
static fn_cuDeviceGet              pcu_DeviceGet = NULL;
static fn_cuCtxCreate              pcu_CtxCreate = NULL;
static fn_cuCtxSetCurrent          pcu_CtxSetCurrent = NULL;
static fn_cuModuleLoadData         pcu_ModuleLoadData = NULL;
static fn_cuModuleGetFunction      pcu_ModuleGetFunction = NULL;
static fn_cuLaunchKernel           pcu_LaunchKernel = NULL;
static fn_cuMemAlloc               pcu_MemAlloc = NULL;
static fn_cuMemFree                pcu_MemFree = NULL;
static fn_cuMemcpyHtoD             pcu_MemcpyHtoD = NULL;
static fn_cuMemcpyDtoH             pcu_MemcpyDtoH = NULL;
static fn_cuCtxSynchronize         pcu_CtxSynchronize = NULL;
static fn_cuMemGetInfo             pcu_MemGetInfo = NULL;
static fn_cuGetErrorString         pcu_GetErrorString = NULL;

static int gcu_inited = 0;

// nxcu_proc resolves `base "_v2"` FIRST, falling back to the bare
// `base` name — the driver API's versioned-symbol convention. Modern
// nvcuda.dll exports BOTH the bare pre-CUDA-4.0 symbol (e.g.
// "cuMemAlloc") AND the current "_v2" one (e.g. "cuMemAlloc_v2") for
// binary compatibility with ancient binaries — the bare one is NOT an
// alias for _v2, it is the actual old entry point with old (broken,
// for our purposes) semantics: resolving it instead of _v2 was
// measured to fail every subsequent call with CUDA_ERROR_INVALID_CONTEXT
// (201) even immediately after a successful cuCtxSetCurrent, because
// the legacy entry point consults the pre-4.0 context-stack API
// (cuCtxPushCurrent/cuCtxAttach) rather than the modern per-thread
// "current context" cuCtxSetCurrent writes to. Preferring "_v2" matches
// what cuda.h's own macros do for code compiled the normal way (nvcc
// never emits a call to the bare symbol at all). A handful of entry
// points here (cuModuleLoadData, cuLaunchKernel, cuCtxSetCurrent, ...)
// were never versioned and only the bare name exists — the fallback
// covers those.
static void* nxcu_proc(HMODULE h, const char* base) {
	{
		char name[256];
		wsprintfA(name, "%s_v2", base);
		void* p = (void*)GetProcAddress(h, name);
		if (p) return p;
	}
	return (void*)GetProcAddress(h, base);
}

static int nxcu_dyn_init(void) {
	if (gcu_inited) return 0;
	gcu_lib = LoadLibraryA("nvcuda.dll");
	if (!gcu_lib) return 401;

	pcu_Init               = (fn_cuInit)               nxcu_proc(gcu_lib, "cuInit");
	pcu_DeviceGet           = (fn_cuDeviceGet)           nxcu_proc(gcu_lib, "cuDeviceGet");
	pcu_CtxCreate           = (fn_cuCtxCreate)           nxcu_proc(gcu_lib, "cuCtxCreate");
	pcu_CtxSetCurrent       = (fn_cuCtxSetCurrent)       nxcu_proc(gcu_lib, "cuCtxSetCurrent");
	pcu_ModuleLoadData      = (fn_cuModuleLoadData)      nxcu_proc(gcu_lib, "cuModuleLoadData");
	pcu_ModuleGetFunction   = (fn_cuModuleGetFunction)   nxcu_proc(gcu_lib, "cuModuleGetFunction");
	pcu_LaunchKernel        = (fn_cuLaunchKernel)        nxcu_proc(gcu_lib, "cuLaunchKernel");
	pcu_MemAlloc            = (fn_cuMemAlloc)            nxcu_proc(gcu_lib, "cuMemAlloc");
	pcu_MemFree             = (fn_cuMemFree)             nxcu_proc(gcu_lib, "cuMemFree");
	pcu_MemcpyHtoD          = (fn_cuMemcpyHtoD)          nxcu_proc(gcu_lib, "cuMemcpyHtoD");
	pcu_MemcpyDtoH          = (fn_cuMemcpyDtoH)          nxcu_proc(gcu_lib, "cuMemcpyDtoH");
	// cuCtxSynchronize is the ONE function on this driver where "_v2"
	// is NOT an alias/superset of the bare symbol but a genuinely
	// different, distinct-address export (confirmed via GetProcAddress
	// on both names) that reliably returns CUDA_ERROR_CONTEXT_IS_DESTROYED
	// (709) when called on our cuCtxCreate'd context, even immediately
	// after successful cuCtxCreate+cuCtxSetCurrent with zero other work
	// done — while the bare "cuCtxSynchronize" symbol works every time.
	// nxcu_proc's normal "_v2 first" preference is deliberately NOT
	// applied here; every other _v2-having function in this file (the
	// cuMemAlloc/cuMemFree/cuMemcpyHtoD/cuMemcpyDtoH/cuMemGetInfo
	// family) was measured the opposite way (_v2 correct, bare broken —
	// see nxcu_proc's doc comment), so this is a genuine per-function
	// quirk of this driver, not a pattern to generalize either way.
	pcu_CtxSynchronize      = (fn_cuCtxSynchronize)      GetProcAddress(gcu_lib, "cuCtxSynchronize");
	pcu_MemGetInfo          = (fn_cuMemGetInfo)          nxcu_proc(gcu_lib, "cuMemGetInfo");
	pcu_GetErrorString      = (fn_cuGetErrorString)      nxcu_proc(gcu_lib, "cuGetErrorString");
	if (!pcu_Init || !pcu_DeviceGet || !pcu_CtxCreate || !pcu_CtxSetCurrent ||
		!pcu_ModuleLoadData || !pcu_ModuleGetFunction || !pcu_LaunchKernel ||
		!pcu_MemAlloc || !pcu_MemFree || !pcu_MemcpyHtoD || !pcu_MemcpyDtoH ||
		!pcu_CtxSynchronize || !pcu_MemGetInfo) {
		return 402;
	}

	{
		int rc = pcu_Init(0);
		if (rc != 0) return 1000 + rc;
	}
	{
		CUdevice dev;
		int rc = pcu_DeviceGet(&dev, 0);
		if (rc != 0) return 2000 + rc;
		// A regular (non-primary) context, not cuDevicePrimaryCtxRetain —
		// see nxcu_proc's doc comment's sibling note below and the
		// package-level explanation near ensureThreadContext for why:
		// on this machine/driver, a RETAINED PRIMARY context reports
		// itself as valid and current (cuCtxGetCurrent/
		// cuDevicePrimaryCtxGetState both agree) yet cuCtxSynchronize on
		// it still fails with CUDA_ERROR_CONTEXT_IS_DESTROYED (709) —
		// reproduced in isolation with zero allocations/launches, and
		// with the exact same DLL/symbols/device, cuCtxCreate + the same
		// cuCtxSynchronize call succeeds every time. cuMemAlloc/
		// cuMemcpyHtoD/cuMemcpyDtoH/cuLaunchKernel all worked fine on
		// the primary context regardless, so this was invisible until
		// something called Synchronize directly (see DeviceMemInfo/
		// Module.Launch, which never needed to before profiling). A
		// regular context is exclusively ours (no interop/sharing with
		// a cudart-based context elsewhere in this process), which is
		// fine — the compute package's cudart-based bridges
		// (cublas_dyn.go, cublas_int8_dyn.go) never share GPU state with
		// this file; each owns an independent handle already.
		rc = pcu_CtxCreate(&gcu_ctx, 0, dev);
		if (rc != 0) return 3000 + rc;
		rc = pcu_CtxSetCurrent(gcu_ctx);
		if (rc != 0) return 4000 + rc;
	}

	gcu_inited = 1;
	return 0;
}

// nxcu_set_current re-applies our context to whichever OS thread is
// calling — the CUDA driver API's context is thread-local,
// but Go goroutines are NOT pinned to one OS thread unless the caller
// holds runtime.LockOSThread, so every entry point that makes a driver
// call must re-assert the context on its current thread even after
// nxcu_dyn_init already ran once (possibly on a different thread).
// Cheap: this is a simple thread-local-storage write in the driver, not
// a device round trip.
static int nxcu_set_current(void) {
	if (!gcu_inited) return -1;
	return pcu_CtxSetCurrent(gcu_ctx);
}

static int nxcu_module_load(CUmodule* mod, const void* image) {
	if (!gcu_inited) return -1;
	return pcu_ModuleLoadData(mod, image);
}

static int nxcu_module_get_function(CUfunction* f, CUmodule mod, const char* name) {
	if (!gcu_inited) return -1;
	return pcu_ModuleGetFunction(f, mod, name);
}

static int nxcu_launch(CUfunction f,
	unsigned int gx, unsigned int gy, unsigned int gz,
	unsigned int bx, unsigned int by, unsigned int bz,
	unsigned int shared, void** params) {
	if (!gcu_inited) return -1;
	return pcu_LaunchKernel(f, gx, gy, gz, bx, by, bz, shared, NULL, params, NULL);
}

static int nxcu_mem_alloc(CUdeviceptr* dptr, size_t bytes) {
	if (!gcu_inited) return -1;
	return pcu_MemAlloc(dptr, bytes);
}

static int nxcu_mem_free(CUdeviceptr dptr) {
	if (!gcu_inited) return -1;
	return pcu_MemFree(dptr);
}

static int nxcu_memcpy_htod(CUdeviceptr dst, const void* src, size_t bytes) {
	if (!gcu_inited) return -1;
	return pcu_MemcpyHtoD(dst, src, bytes);
}

static int nxcu_memcpy_dtoh(void* dst, CUdeviceptr src, size_t bytes) {
	if (!gcu_inited) return -1;
	return pcu_MemcpyDtoH(dst, src, bytes);
}

static int nxcu_synchronize(void) {
	if (!gcu_inited) return -1;
	return pcu_CtxSynchronize();
}

static int nxcu_meminfo(size_t* freeBytes, size_t* totalBytes) {
	if (!gcu_inited) return -1;
	return pcu_MemGetInfo(freeBytes, totalBytes);
}

static const char* nxcu_errstr(int code) {
	const char* s = NULL;
	if (gcu_inited && pcu_GetErrorString && pcu_GetErrorString(code, &s) == 0 && s) {
		return s;
	}
	return "unknown";
}
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"
)

var (
	cudaDriverOnce sync.Once
	cudaDriverErr  error
)

// initCUDADriver loads nvcuda.dll, calls cuInit, and creates+activates a
// context on device 0 (cuCtxCreate — deliberately NOT
// cuDevicePrimaryCtxRetain; see nxcu_dyn_init's doc comment for the
// measured reason). Idempotent; the first attempt's result is returned
// forever after.
func initCUDADriver() error {
	cudaDriverOnce.Do(func() {
		ret := C.nxcu_dyn_init()
		if ret != 0 {
			cudaDriverErr = fmt.Errorf("cuda driver dynamic init failed (code %d — is the NVIDIA display driver installed? nvcuda.dll should be in C:\\Windows\\System32)", int(ret))
		}
	})
	return cudaDriverErr
}

// ensureThreadContext must be called by every exported function in this
// file that makes a CUDA driver call, BEFORE that call. The driver API's
// current context is thread-local, but a Go goroutine is not pinned to
// one OS thread unless it holds runtime.LockOSThread — without this, a
// goroutine that resumes on a different M after a scheduling point sees
// "invalid context" (CUDA_ERROR_INVALID_CONTEXT) even though
// initCUDADriver already ran successfully once, elsewhere. LockOSThread
// is cheap to call repeatedly (idempotent w.r.t. the calling goroutine)
// and deliberately never paired with UnlockOSThread — once a goroutine
// touches CUDA it should stay pinned for its lifetime, matching every
// other Go+CUDA-driver-API binding's convention.
func ensureThreadContext() error {
	runtime.LockOSThread()
	if err := initCUDADriver(); err != nil {
		return err
	}
	if rc := C.nxcu_set_current(); rc != 0 {
		return fmt.Errorf("cuCtxSetCurrent failed (code %d: %s)", int(rc), cuErrStr(rc))
	}
	return nil
}

func cuErrStr(code C.int) string {
	return C.GoString(C.nxcu_errstr(code))
}

// ─────────────────────────────────────────────────────────────────────
// Module — a loaded PTX image plus a name→CUfunction cache.
// ─────────────────────────────────────────────────────────────────────

// Module is a CUDA module loaded from PTX (see CompileKernels), holding
// every `extern "C" __global__` kernel the source defines. Not safe for
// concurrent Launch calls from multiple goroutines without external
// synchronization — decode is inherently sequential per BitNetCUDADecoder
// anyway (bitnet_cuda.go never calls Launch concurrently).
type Module struct {
	mod C.CUmodule
	fns map[string]C.CUfunction
}

// CompileKernels compiles CUDA C source `src` via NVRTC (nvrtc_dyn.go's
// CompileToPTX — disk-cached by source hash) and loads the resulting PTX
// into the active CUDA context, returning a Module ready for Launch.
func CompileKernels(src string) (*Module, error) {
	if err := ensureThreadContext(); err != nil {
		return nil, err
	}
	ptx, err := CompileToPTX(src)
	if err != nil {
		return nil, err
	}

	cptx := C.CString(ptx)
	defer C.free(unsafe.Pointer(cptx))

	var mod C.CUmodule
	rc := C.nxcu_module_load(&mod, unsafe.Pointer(cptx))
	if rc != 0 {
		return nil, fmt.Errorf("cuModuleLoadData failed (code %d: %s)", int(rc), cuErrStr(rc))
	}
	return &Module{mod: mod, fns: make(map[string]C.CUfunction)}, nil
}

func (m *Module) getFunction(name string) (C.CUfunction, error) {
	if f, ok := m.fns[name]; ok {
		return f, nil
	}
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	var f C.CUfunction
	rc := C.nxcu_module_get_function(&f, m.mod, cname)
	if rc != 0 {
		return nil, fmt.Errorf("cuModuleGetFunction(%q) failed (code %d: %s)", name, int(rc), cuErrStr(rc))
	}
	m.fns[name] = f
	return f, nil
}

// Launch runs kernel `name` with the given grid/block dimensions (each a
// [3]uint32 of {x,y,z}; unused dimensions should be 1), sharedMemBytes
// of dynamic shared memory, and the arguments built by args (see
// KernelArgs) — on the default stream, then blocks until the kernel's
// parameter buffer has been consumed (cuLaunchKernel itself is
// asynchronous; args.Release() below is safe to call right after Launch
// returns because argument marshaling completes before the driver call
// returns, not when the kernel finishes). Launch does NOT call
// Synchronize — kernels queue on the default stream and run in the
// order launched; callers needing a specific kernel's output on the
// host must call Synchronize (or rely on CopyToHost's synchronous
// cuMemcpyDtoH, which implicitly waits for prior work on the stream).
func (m *Module) Launch(name string, grid, block [3]uint32, sharedMemBytes uint32, args *KernelArgs) error {
	if err := ensureThreadContext(); err != nil {
		return err
	}
	f, err := m.getFunction(name)
	if err != nil {
		return err
	}
	arr := args.buildArray()
	if arr != nil {
		defer C.free(arr)
	}
	rc := C.nxcu_launch(f,
		C.uint(grid[0]), C.uint(grid[1]), C.uint(grid[2]),
		C.uint(block[0]), C.uint(block[1]), C.uint(block[2]),
		C.uint(sharedMemBytes), (*unsafe.Pointer)(arr))
	if rc != 0 {
		return fmt.Errorf("cuLaunchKernel(%q) failed (code %d: %s)", name, int(rc), cuErrStr(rc))
	}
	return nil
}

// Synchronize blocks until all work queued on the (default) stream has
// completed — cuCtxSynchronize.
func Synchronize() error {
	if err := ensureThreadContext(); err != nil {
		return err
	}
	rc := C.nxcu_synchronize()
	if rc != 0 {
		return fmt.Errorf("cuCtxSynchronize failed (code %d: %s)", int(rc), cuErrStr(rc))
	}
	return nil
}

// DeviceMemInfo reports free/total device memory in bytes (cuMemGetInfo).
func DeviceMemInfo() (free, total uint64, err error) {
	if e := ensureThreadContext(); e != nil {
		return 0, 0, e
	}
	var f, t C.size_t
	rc := C.nxcu_meminfo(&f, &t)
	if rc != 0 {
		return 0, 0, fmt.Errorf("cuMemGetInfo failed (code %d: %s)", int(rc), cuErrStr(rc))
	}
	return uint64(f), uint64(t), nil
}

// ─────────────────────────────────────────────────────────────────────
// DeviceBuffer — cuMemAlloc-backed device memory.
// ─────────────────────────────────────────────────────────────────────

// DeviceBuffer is a fixed-size block of device memory.
type DeviceBuffer struct {
	ptr  C.CUdeviceptr
	size int
}

// AllocDevice allocates `bytes` of device memory (cuMemAlloc).
func AllocDevice(bytes int) (*DeviceBuffer, error) {
	if err := ensureThreadContext(); err != nil {
		return nil, err
	}
	if bytes <= 0 {
		return nil, errors.New("cuda: AllocDevice: bytes must be > 0")
	}
	var dptr C.CUdeviceptr
	rc := C.nxcu_mem_alloc(&dptr, C.size_t(bytes))
	if rc != 0 {
		return nil, fmt.Errorf("cuMemAlloc(%d) failed (code %d: %s)", bytes, int(rc), cuErrStr(rc))
	}
	return &DeviceBuffer{ptr: dptr, size: bytes}, nil
}

// Free releases the device memory. Safe to call on an already-freed or
// nil buffer.
func (b *DeviceBuffer) Free() {
	if b == nil || b.ptr == 0 {
		return
	}
	_ = ensureThreadContext() // best-effort; a failure here still tries the free
	C.nxcu_mem_free(b.ptr)
	b.ptr = 0
}

// Size returns the buffer's length in bytes.
func (b *DeviceBuffer) Size() int { return b.size }

// CopyFromHost copies `bytes` bytes from host memory at `src` into the
// start of the device buffer (cuMemcpyHtoD, synchronous w.r.t. the host
// — the call blocks until the copy completes).
func (b *DeviceBuffer) CopyFromHost(src unsafe.Pointer, bytes int) error {
	if bytes <= 0 || bytes > b.size {
		return fmt.Errorf("cuda: CopyFromHost: bytes=%d out of range [1,%d]", bytes, b.size)
	}
	if err := ensureThreadContext(); err != nil {
		return err
	}
	rc := C.nxcu_memcpy_htod(b.ptr, src, C.size_t(bytes))
	if rc != 0 {
		return fmt.Errorf("cuMemcpyHtoD failed (code %d: %s)", int(rc), cuErrStr(rc))
	}
	return nil
}

// CopyToHost copies `bytes` bytes from the start of the device buffer
// into host memory at `dst` (cuMemcpyDtoH, synchronous — also acts as an
// implicit wait for any prior kernels queued on the stream that produced
// this buffer's contents).
func (b *DeviceBuffer) CopyToHost(dst unsafe.Pointer, bytes int) error {
	if bytes <= 0 || bytes > b.size {
		return fmt.Errorf("cuda: CopyToHost: bytes=%d out of range [1,%d]", bytes, b.size)
	}
	if err := ensureThreadContext(); err != nil {
		return err
	}
	rc := C.nxcu_memcpy_dtoh(dst, b.ptr, C.size_t(bytes))
	if rc != 0 {
		return fmt.Errorf("cuMemcpyDtoH failed (code %d: %s)", int(rc), cuErrStr(rc))
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────
// KernelArgs — the void** parameter array cuLaunchKernel needs, built
// entirely out of C-owned memory.
// ─────────────────────────────────────────────────────────────────────

// KernelArgs accumulates typed kernel arguments in the order a kernel's
// parameter list expects, each copied into its own C.malloc'd slot (so
// cuLaunchKernel's kernelParams[i] can point directly at the argument's
// bytes, per the driver API's calling convention) — never a Go pointer,
// so nothing here can trip cgo's Go-pointer-passed-to-C checks. Call
// Release after the Launch call that consumes it (Launch itself frees
// only the top-level array it builds from these slots, not the slots
// themselves, since the same KernelArgs could in principle be launched
// more than once).
type KernelArgs struct {
	slots []unsafe.Pointer
}

// NewKernelArgs returns an empty argument list.
func NewKernelArgs() *KernelArgs { return &KernelArgs{} }

func (a *KernelArgs) addSlot(size uintptr, write func(unsafe.Pointer)) *KernelArgs {
	p := C.malloc(C.size_t(size))
	write(p)
	a.slots = append(a.slots, p)
	return a
}

// AddDevicePtr appends a device buffer's base pointer (the CUdeviceptr
// value itself, boxed into a slot — kernels declare the corresponding
// parameter as a plain device pointer type, e.g. `const float* x`).
func (a *KernelArgs) AddDevicePtr(b *DeviceBuffer) *KernelArgs {
	return a.addSlot(8, func(p unsafe.Pointer) {
		*(*C.CUdeviceptr)(p) = b.ptr
	})
}

// AddDevicePtrOffset appends a device buffer's base pointer advanced by
// byteOffset bytes — for kernels that address one row/slice of a larger
// resident buffer (e.g. the KV cache's [layer][position] rows in
// cortex/bitnet_cuda.go). CUdeviceptr arithmetic is a plain unsigned
// 64-bit add, exactly like pointer arithmetic on the device side.
func (a *KernelArgs) AddDevicePtrOffset(b *DeviceBuffer, byteOffset int) *KernelArgs {
	return a.addSlot(8, func(p unsafe.Pointer) {
		*(*C.CUdeviceptr)(p) = b.ptr + C.CUdeviceptr(byteOffset)
	})
}

// AddInt32 appends a 4-byte signed integer argument (kernel parameter
// type `int`).
func (a *KernelArgs) AddInt32(v int32) *KernelArgs {
	return a.addSlot(4, func(p unsafe.Pointer) { *(*C.int32_t)(p) = C.int32_t(v) })
}

// AddUint32 appends a 4-byte unsigned integer argument (kernel parameter
// type `unsigned int`).
func (a *KernelArgs) AddUint32(v uint32) *KernelArgs {
	return a.addSlot(4, func(p unsafe.Pointer) { *(*C.uint32_t)(p) = C.uint32_t(v) })
}

// AddFloat32 appends a 4-byte float argument (kernel parameter type
// `float`).
func (a *KernelArgs) AddFloat32(v float32) *KernelArgs {
	return a.addSlot(4, func(p unsafe.Pointer) { *(*C.float)(p) = C.float(v) })
}

// AddFloat64 appends an 8-byte double argument (kernel parameter type
// `double` — used for rmsnorm's eps, matching the CPU's float64 epsilon
// addition).
func (a *KernelArgs) AddFloat64(v float64) *KernelArgs {
	return a.addSlot(8, func(p unsafe.Pointer) { *(*C.double)(p) = C.double(v) })
}

// buildArray copies the slot pointers (each already C memory) into a
// freshly C.malloc'd void** array in call order, for cuLaunchKernel's
// kernelParams. Returns nil for an empty argument list (cuLaunchKernel
// accepts NULL kernelParams when a kernel takes no arguments).
func (a *KernelArgs) buildArray() unsafe.Pointer {
	n := len(a.slots)
	if n == 0 {
		return nil
	}
	arr := C.malloc(C.size_t(n) * C.size_t(unsafe.Sizeof(uintptr(0))))
	out := unsafe.Slice((*unsafe.Pointer)(arr), n)
	copy(out, a.slots)
	return arr
}

// Release frees every argument slot this KernelArgs owns. Call once
// after the Launch(es) that use it are done with it.
func (a *KernelArgs) Release() {
	for _, p := range a.slots {
		C.free(p)
	}
	a.slots = nil
}
