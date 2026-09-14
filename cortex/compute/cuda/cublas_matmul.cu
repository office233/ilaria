// cublas_matmul.cu — float32 dense matmul bridge backed by cuBLAS sgemm.
//
// We expose two entry points to Go:
//   nexus_cublas_sgemm   : C = A * B
//   nexus_cublas_sgemm_nt: C = A * B^T  (B is given as row-major [N,K])
//
// Row-major vs column-major trick
// --------------------------------
// cuBLAS is column-major. Go tensors are row-major. The identity
//     (A_row * B_row)^T  ==  B_col * A_col
// lets us compute a row-major C[M,N] = A[M,K] * B[K,N] by calling cuBLAS
// as if it were   C_col[N,M] = B_col[N,K] * A_col[K,M]
// and reading the result back as row-major C[M,N]. No actual transpose
// happens — the underlying memory layout is identical.
//
// We allocate device buffers per call (small overhead — for the matmuls
// in a 5M-param transformer the H2D/D2H copy is the bottleneck anyway,
// not allocation). A future optimisation is a pinned-host arena +
// device buffer pool, but we keep it simple until profiled.

#include "cuda_bridge.h"

#include <cuda_runtime.h>
#include <cublas_v2.h>

#include <vector>

namespace {

cublasHandle_t g_handle = nullptr;
bool           g_inited = false;

// ─── Resident weight registry ────────────────────────────────────────
// Weights uploaded once via nexus_cublas_upload_weight live here for
// the process lifetime (or until freed). Handles are indices; freed
// slots are reused. Access is serialised by the Go-side mutex, same as
// every other cuBLAS entry point.
struct ResidentWeight {
    float* ptr;
    size_t count;
};
std::vector<ResidentWeight> g_weights;

// ─── Persistent device buffer arena ──────────────────────────────────
// cudaMalloc / cudaFree cost ~100 microseconds each on Windows. For a
// 100us matmul, that's pure waste. We keep three reusable device buffers
// (A, B, C) that grow on demand and never shrink, so the typical matmul
// pays zero allocation cost.
struct DeviceBuf {
    float* ptr;
    size_t bytes;
};
DeviceBuf g_bufA{nullptr, 0};
DeviceBuf g_bufB{nullptr, 0};
DeviceBuf g_bufC{nullptr, 0};

inline int ensureBuf(DeviceBuf& b, size_t needed) {
    if (b.bytes >= needed) return 0;
    if (b.ptr) cudaFree(b.ptr);
    b.ptr = nullptr;
    b.bytes = 0;
    cudaError_t e = cudaMalloc(&b.ptr, needed);
    if (e != cudaSuccess) return 1;
    b.bytes = needed;
    return 0;
}

inline void freeBuf(DeviceBuf& b) {
    if (b.ptr) cudaFree(b.ptr);
    b.ptr = nullptr;
    b.bytes = 0;
}

inline int check(cudaError_t e) {
    return (e == cudaSuccess) ? 0 : 1;
}

inline int check(cublasStatus_t s) {
    return (s == CUBLAS_STATUS_SUCCESS) ? 0 : 1;
}

} // namespace

extern "C" {

NEXUS_API int nexus_cublas_init(int device_id) {
    if (g_inited) return 0;
    if (check(cudaSetDevice(device_id)) != 0) return 1;
    if (check(cublasCreate(&g_handle)) != 0) return 2;
    g_inited = true;
    return 0;
}

NEXUS_API void nexus_cublas_close(void) {
    freeBuf(g_bufA);
    freeBuf(g_bufB);
    freeBuf(g_bufC);
    for (auto& w : g_weights) {
        if (w.ptr) cudaFree(w.ptr);
        w.ptr = nullptr;
        w.count = 0;
    }
    g_weights.clear();
    if (g_handle != nullptr) {
        cublasDestroy(g_handle);
        g_handle = nullptr;
    }
    g_inited = false;
}

NEXUS_API int nexus_cublas_upload_weight(const float* data, int64_t count) {
    if (!g_inited) return -1;
    if (data == nullptr || count <= 0) return -2;

    float* dev = nullptr;
    const size_t bytes = static_cast<size_t>(count) * sizeof(float);
    if (check(cudaMalloc(&dev, bytes)) != 0) return -3;
    if (check(cudaMemcpy(dev, data, bytes, cudaMemcpyHostToDevice)) != 0) {
        cudaFree(dev);
        return -4;
    }

    // Reuse a freed slot when available so long-lived processes that
    // cycle models don't grow the registry without bound.
    for (size_t i = 0; i < g_weights.size(); i++) {
        if (g_weights[i].ptr == nullptr) {
            g_weights[i] = {dev, static_cast<size_t>(count)};
            return static_cast<int>(i);
        }
    }
    g_weights.push_back({dev, static_cast<size_t>(count)});
    return static_cast<int>(g_weights.size() - 1);
}

NEXUS_API void nexus_cublas_free_weight(int handle) {
    if (handle < 0 || static_cast<size_t>(handle) >= g_weights.size()) return;
    if (g_weights[handle].ptr) cudaFree(g_weights[handle].ptr);
    g_weights[handle] = {nullptr, 0};
}

NEXUS_API int nexus_cublas_update_weight(int handle, const float* data, int64_t count) {
    if (!g_inited) return -1;
    if (handle < 0 || static_cast<size_t>(handle) >= g_weights.size()) return -5;
    ResidentWeight& w = g_weights[handle];
    if (w.ptr == nullptr || data == nullptr || count <= 0 ||
        static_cast<size_t>(count) != w.count) return -2;
    if (check(cudaMemcpy(w.ptr, data,
            static_cast<size_t>(count) * sizeof(float),
            cudaMemcpyHostToDevice)) != 0) return -4;
    return 0;
}

// Y[M,N] = X[M,K] * W (or * W^T). Same column-major reformulations as
// nexus_cublas_sgemm / _nt above — the only difference is that W is
// already on the device, so per call only X (M*K floats) goes up and Y
// (M*N floats) comes down.
NEXUS_API int nexus_cublas_sgemm_resident(
    int weightHandle, const float* X, float* Y,
    int M, int N, int K, int transW)
{
    if (!g_inited) return -1;
    if (M <= 0 || N <= 0 || K <= 0) return -2;
    if (weightHandle < 0 || static_cast<size_t>(weightHandle) >= g_weights.size()) return -5;

    const ResidentWeight& w = g_weights[weightHandle];
    const size_t needW = static_cast<size_t>(N) * K;
    if (w.ptr == nullptr || w.count < needW) return -6;

    const size_t bytesX = static_cast<size_t>(M) * K * sizeof(float);
    const size_t bytesY = static_cast<size_t>(M) * N * sizeof(float);
    if (ensureBuf(g_bufA, bytesX) != 0) return 10;
    if (ensureBuf(g_bufC, bytesY) != 0) return 12;

    if (check(cudaMemcpy(g_bufA.ptr, X, bytesX, cudaMemcpyHostToDevice)) != 0) return 20;

    const float alpha = 1.0f, beta = 0.0f;
    cublasStatus_t st;
    if (transW == 0) {
        // Row-major Y = X * W[K,N] → column-major Y[N,M] = W_col[N,K] * X_col[K,M].
        st = cublasSgemm(g_handle, CUBLAS_OP_N, CUBLAS_OP_N,
                         N, M, K, &alpha,
                         w.ptr, N,
                         g_bufA.ptr, K,
                         &beta, g_bufC.ptr, N);
    } else {
        // Row-major Y = X * W[N,K]^T → same shape trick as sgemm_nt.
        st = cublasSgemm(g_handle, CUBLAS_OP_T, CUBLAS_OP_N,
                         N, M, K, &alpha,
                         w.ptr, K,
                         g_bufA.ptr, K,
                         &beta, g_bufC.ptr, N);
    }
    if (check(st) != 0) return 30;

    if (check(cudaMemcpy(Y, g_bufC.ptr, bytesY, cudaMemcpyDeviceToHost)) != 0) return 40;
    return 0;
}

// C[M,N] = A[M,K] * B[K,N]   (all row-major)
//
// Trick: ask cuBLAS to compute C_col[N,M] = B_col[N,K] * A_col[K,M] using
// no transpositions. Since column-major(X[r,c]) = row-major(X^T[c,r]),
// the bytes we write back are exactly the row-major C[M,N] we want.
NEXUS_API int nexus_cublas_sgemm(
    const float* A, const float* B, float* C,
    int M, int N, int K)
{
    if (!g_inited) return -1;
    if (M <= 0 || N <= 0 || K <= 0) return -2;

    const size_t bytesA = static_cast<size_t>(M) * K * sizeof(float);
    const size_t bytesB = static_cast<size_t>(K) * N * sizeof(float);
    const size_t bytesC = static_cast<size_t>(M) * N * sizeof(float);

    if (ensureBuf(g_bufA, bytesA) != 0) return 10;
    if (ensureBuf(g_bufB, bytesB) != 0) return 11;
    if (ensureBuf(g_bufC, bytesC) != 0) return 12;

    if (check(cudaMemcpy(g_bufA.ptr, A, bytesA, cudaMemcpyHostToDevice)) != 0) return 20;
    if (check(cudaMemcpy(g_bufB.ptr, B, bytesB, cudaMemcpyHostToDevice)) != 0) return 21;

    const float alpha = 1.0f, beta = 0.0f;
    // Compute C_col[N,M] = B_col[N,K] * A_col[K,M]
    //   op(B) is [N,K] column-major, leading dim ldb = N
    //   op(A) is [K,M] column-major, leading dim lda = K
    //   C is [N,M] column-major, leading dim ldc = N
    if (check(cublasSgemm(
            g_handle,
            CUBLAS_OP_N, CUBLAS_OP_N,
            N, M, K,
            &alpha,
            g_bufB.ptr, N,
            g_bufA.ptr, K,
            &beta,
            g_bufC.ptr, N)) != 0) return 30;

    if (check(cudaMemcpy(C, g_bufC.ptr, bytesC, cudaMemcpyDeviceToHost)) != 0) return 40;
    return 0;
}

// C[M,N] = A[M,K] * B[N,K]^T   (B is row-major [N,K])
//
// Same column-major trick. We want row-major C[M,N] = A * B^T.
// Equivalent column-major: C_col[N,M] = B_col[N,K] * A_col[K,M]^? — no:
// reformulate. We want row-major C = A * B^T. Take transpose:
//   C^T = B * A^T   (row-major identity)
// Column-major of C is row-major of C^T. So column-major C[N,M] = B[N,K] * A^T[K,M].
// In cuBLAS column-major:
//   op(B) is B treated as column-major [K,N] but we want it as [N,K] —
//   that means we need to TRANSPOSE B for cuBLAS (CUBLAS_OP_T).
//   But B's bytes are row-major [N,K]; that's identical to column-major [K,N].
//   Apply CUBLAS_OP_T → cuBLAS sees [N,K] (which is what we want).
//   op(A^T) means we want A^T column-major [K,M]; A's bytes are row-major [M,K]
//   = column-major [K,M] already — exactly what we want, so CUBLAS_OP_N on A.
//
//   sgemm(opA=T on B, opB=N on A, m=N, n=M, k=K,
//         A=B (ld=K), B=A (ld=K), C (ld=N))
NEXUS_API int nexus_cublas_sgemm_nt(
    const float* A, const float* B, float* C,
    int M, int N, int K)
{
    if (!g_inited) return -1;
    if (M <= 0 || N <= 0 || K <= 0) return -2;

    const size_t bytesA = static_cast<size_t>(M) * K * sizeof(float);
    const size_t bytesB = static_cast<size_t>(N) * K * sizeof(float);
    const size_t bytesC = static_cast<size_t>(M) * N * sizeof(float);

    if (ensureBuf(g_bufA, bytesA) != 0) return 10;
    if (ensureBuf(g_bufB, bytesB) != 0) return 11;
    if (ensureBuf(g_bufC, bytesC) != 0) return 12;

    if (check(cudaMemcpy(g_bufA.ptr, A, bytesA, cudaMemcpyHostToDevice)) != 0) return 20;
    if (check(cudaMemcpy(g_bufB.ptr, B, bytesB, cudaMemcpyHostToDevice)) != 0) return 21;

    const float alpha = 1.0f, beta = 0.0f;
    if (check(cublasSgemm(
            g_handle,
            CUBLAS_OP_T, CUBLAS_OP_N,
            N, M, K,
            &alpha,
            g_bufB.ptr, K,
            g_bufA.ptr, K,
            &beta,
            g_bufC.ptr, N)) != 0) return 30;

    if (check(cudaMemcpy(C, g_bufC.ptr, bytesC, cudaMemcpyDeviceToHost)) != 0) return 40;
    return 0;
}

} // extern "C"
