// cuda_bridge.h — C API for Nexus Cortex CUDA compute kernels.
// Called from Go via CGO. All functions return 0 on success, non-zero on error.

#ifndef CUDA_BRIDGE_H
#define CUDA_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef _WIN32
  #ifdef CUDA_NEXUS_EXPORTS
    #define NEXUS_API __declspec(dllexport)
  #else
    #define NEXUS_API __declspec(dllimport)
  #endif
#else
  #define NEXUS_API
#endif

// Initialize CUDA device. Returns 0 on success.
NEXUS_API int nexus_cuda_init(int device_id);

// Release CUDA resources.
NEXUS_API void nexus_cuda_close(void);

// ForwardSparse: ternary neural layer forward pass.
NEXUS_API int nexus_cuda_forward_sparse(
    const uint32_t* activeIndices,
    const int32_t*  activeValues,
    uint32_t        activeCount,
    const uint32_t* tiles,
    const int32_t*  bias,
    int32_t*        output,
    uint32_t        tilesPerRow,
    uint32_t        outputSize
);

// BatchSDRSimilarity: compute popcount(query & memory[i]) for each memory SDR.
NEXUS_API int nexus_cuda_batch_sdr_similarity(
    const uint32_t* querySDR,
    const uint32_t* memorySDRs,
    uint8_t*        results,
    uint32_t        queryWords,
    uint32_t        numMemories
);

// ─── cuBLAS dense float32 matmul ─────────────────────────────────────────
//
// All matrices are ROW-MAJOR (the way Go stores them). The bridge handles
// the row<->column-major flip when calling cuBLAS internally.
//
// Lifecycle: call nexus_cublas_init() once at startup, nexus_cublas_close()
// at shutdown. The handle is process-global; concurrent sgemm calls from
// Go must be serialised by the caller (cuBLAS handles are NOT thread-safe).

// Initialise the cuBLAS handle. Returns 0 on success.
NEXUS_API int nexus_cublas_init(int device_id);

// Release the cuBLAS handle.
NEXUS_API void nexus_cublas_close(void);

// C[M,N] = A[M,K] * B[K,N]    (all row-major)
// Returns 0 on success, non-zero on any CUDA/cuBLAS error.
NEXUS_API int nexus_cublas_sgemm(
    const float* A, const float* B, float* C,
    int M, int N, int K
);

// C[M,N] = A[M,K] * B[N,K]^T  (all row-major; B is logically [N,K])
// Equivalent to Tensor.MatMulTransposed.
NEXUS_API int nexus_cublas_sgemm_nt(
    const float* A, const float* B, float* C,
    int M, int N, int K
);

// ─── Resident weights ────────────────────────────────────────────────
//
// Generation is GEMV-bound: per token the activations are a few KB but
// the weights are hundreds of MB. Copying weights host→device per call
// (as sgemm above does) costs more than the compute itself. These entry
// points upload a weight matrix ONCE and refer to it by handle, so a
// per-token call moves only the activation vector across PCIe.

// Upload `count` floats of weight data to the device. Returns a handle
// >= 0 on success, negative on failure. The data is copied; the host
// buffer may be freed afterwards.
NEXUS_API int nexus_cublas_upload_weight(const float* data, int64_t count);

// Release one uploaded weight. Invalid handles are ignored.
NEXUS_API void nexus_cublas_free_weight(int handle);

// Y[M,N] = X[M,K] * W       (transW == 0; W is resident, row-major [K,N])
// Y[M,N] = X[M,K] * W^T     (transW != 0; W is resident, row-major [N,K])
// X and Y are host row-major; only they cross PCIe.
NEXUS_API int nexus_cublas_sgemm_resident(
    int weightHandle, const float* X, float* Y,
    int M, int N, int K, int transW
);

#ifdef __cplusplus
}
#endif

#endif // CUDA_BRIDGE_H
