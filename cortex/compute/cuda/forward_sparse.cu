// forward_sparse.cu — CUDA kernels for Ilaria neural computation.
//
// Kernel 1: forward_sparse_kernel
//   Computes ternary neural layer forward pass using hardware __popc().
//   Each thread handles one output neuron.
//
// Kernel 2: batch_sdr_similarity_kernel
//   Computes popcount(query & memory[i]) for batch SDR similarity.
//   Each thread handles one memory SDR.

#include <stdint.h>
#include <stdio.h>
#include "cuda_bridge.h"

// ─────────────────────────────────────────────────────────────────────
// Kernel 1: ForwardSparse — Ternary popcount forward pass
// ─────────────────────────────────────────────────────────────────────
//
// TernaryTile layout (uint32):
//   bits  [0..7]   = signLo  (8 weights: 0=positive, 1=negative)
//   bits  [8..15]  = maskLo  (8 weights: 0=zero, 1=active)
//   bits [16..23]  = signHi  (8 weights)
//   bits [24..31]  = maskHi  (8 weights)
//
// For each active input at position idx:
//   tileIdx = rowOffset + (idx / 16)
//   local_pos = idx % 16
//   if mask_bit set: contribution += (sign_bit ? -value : +value)

__global__ void forward_sparse_kernel(
    const uint32_t* __restrict__ activeIndices,
    const int32_t*  __restrict__ activeValues,
    uint32_t        activeCount,
    const uint32_t* __restrict__ tiles,
    const int32_t*  __restrict__ bias,
    int32_t*        __restrict__ output,
    uint32_t        tilesPerRow,
    uint32_t        outputSize
) {
    uint32_t j = blockIdx.x * blockDim.x + threadIdx.x;
    if (j >= outputSize) return;

    int32_t acc = 0;
    uint32_t rowOffset = j * tilesPerRow;

    for (uint32_t i = 0; i < activeCount; i++) {
        uint32_t idx = activeIndices[i];
        uint32_t tileIdx = rowOffset + (idx >> 4); // idx / 16
        uint32_t tile = tiles[tileIdx];

        if (tile == 0) continue; // Skip zero tiles (common with ternary sparsity)

        uint32_t pos = idx & 15u; // idx % 16

        // Determine which byte pair (lo or hi)
        uint32_t shift_base;
        if (pos < 8u) {
            shift_base = 0u;
        } else {
            shift_base = 16u;
        }

        uint32_t local_pos = pos & 7u;
        uint32_t sign_bit = (tile >> (shift_base + local_pos)) & 1u;
        uint32_t mask_bit = (tile >> (shift_base + 8u + local_pos)) & 1u;

        if (mask_bit != 0u) {
            int32_t val = activeValues[i];
            if (sign_bit != 0u) {
                acc -= val;
            } else {
                acc += val;
            }
        }
    }

    // Clamp to int16 range
    if (acc > 32767) acc = 32767;
    if (acc < -32768) acc = -32768;

    output[j] = bias[j] + acc;
}

// ─────────────────────────────────────────────────────────────────────
// Kernel 2: BatchSDRSimilarity — Popcount-based SDR overlap
// ─────────────────────────────────────────────────────────────────────

__global__ void batch_sdr_similarity_kernel(
    const uint32_t* __restrict__ querySDR,
    const uint32_t* __restrict__ memorySDRs,
    uint8_t*        __restrict__ results,
    uint32_t        queryWords,
    uint32_t        numMemories
) {
    uint32_t i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= numMemories) return;

    uint32_t overlap = 0;
    const uint32_t* mem = memorySDRs + i * queryWords;

    for (uint32_t w = 0; w < queryWords; w++) {
        overlap += __popc(querySDR[w] & mem[w]);
    }

    // Cap at 255 for uint8
    results[i] = (overlap > 255u) ? 255u : (uint8_t)overlap;
}

// ─────────────────────────────────────────────────────────────────────
// Host API — Called from CGO
// ─────────────────────────────────────────────────────────────────────

static int cuda_initialized = 0;

extern "C" int ilaria_cuda_init(int device_id) {
    cudaError_t err = cudaSetDevice(device_id);
    if (err != cudaSuccess) {
        fprintf(stderr, "[CUDA] Failed to set device %d: %s\n", device_id, cudaGetErrorString(err));
        return -1;
    }

    // Warm up — force context creation
    cudaFree(0);

    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, device_id);
    fprintf(stderr, "[CUDA] Initialized: %s (SM %d.%d, %d MB, %d cores)\n",
        prop.name, prop.major, prop.minor,
        (int)(prop.totalGlobalMem / (1024 * 1024)),
        prop.multiProcessorCount * 128); // Approximate for Turing

    cuda_initialized = 1;
    return 0;
}

extern "C" void ilaria_cuda_close(void) {
    if (cuda_initialized) {
        cudaDeviceReset();
        cuda_initialized = 0;
    }
}

extern "C" int ilaria_cuda_forward_sparse(
    const uint32_t* activeIndices,
    const int32_t*  activeValues,
    uint32_t        activeCount,
    const uint32_t* tiles,
    const int32_t*  bias,
    int32_t*        output,
    uint32_t        tilesPerRow,
    uint32_t        outputSize
) {
    if (!cuda_initialized) return -1;
    if (activeCount == 0 || outputSize == 0) {
        // Just copy bias to output on host
        for (uint32_t i = 0; i < outputSize; i++) {
            output[i] = bias[i];
        }
        return 0;
    }

    // Device pointers
    uint32_t *d_activeIndices = NULL;
    int32_t  *d_activeValues = NULL;
    uint32_t *d_tiles = NULL;
    int32_t  *d_bias = NULL;
    int32_t  *d_output = NULL;

    size_t activeBytes = activeCount * sizeof(uint32_t);
    size_t valuesBytes = activeCount * sizeof(int32_t);
    size_t tilesBytes  = (size_t)outputSize * tilesPerRow * sizeof(uint32_t);
    size_t biasBytes   = outputSize * sizeof(int32_t);
    size_t outputBytes = outputSize * sizeof(int32_t);

    cudaError_t err;

    // Allocate device memory
    err = cudaMalloc(&d_activeIndices, activeBytes);  if (err != cudaSuccess) goto fail;
    err = cudaMalloc(&d_activeValues, valuesBytes);    if (err != cudaSuccess) goto fail;
    err = cudaMalloc(&d_tiles, tilesBytes);             if (err != cudaSuccess) goto fail;
    err = cudaMalloc(&d_bias, biasBytes);               if (err != cudaSuccess) goto fail;
    err = cudaMalloc(&d_output, outputBytes);           if (err != cudaSuccess) goto fail;

    // Copy host → device
    cudaMemcpy(d_activeIndices, activeIndices, activeBytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_activeValues, activeValues, valuesBytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_tiles, tiles, tilesBytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_bias, bias, biasBytes, cudaMemcpyHostToDevice);

    // Launch kernel
    {
        int threadsPerBlock = 256;
        int blocks = (outputSize + threadsPerBlock - 1) / threadsPerBlock;
        forward_sparse_kernel<<<blocks, threadsPerBlock>>>(
            d_activeIndices, d_activeValues, activeCount,
            d_tiles, d_bias, d_output, tilesPerRow, outputSize
        );
    }

    // Check for kernel errors
    err = cudaGetLastError();
    if (err != cudaSuccess) goto fail;

    // Wait for completion
    err = cudaDeviceSynchronize();
    if (err != cudaSuccess) goto fail;

    // Copy device → host
    cudaMemcpy(output, d_output, outputBytes, cudaMemcpyDeviceToHost);

    // Free device memory
    cudaFree(d_activeIndices);
    cudaFree(d_activeValues);
    cudaFree(d_tiles);
    cudaFree(d_bias);
    cudaFree(d_output);
    return 0;

fail:
    if (d_activeIndices) cudaFree(d_activeIndices);
    if (d_activeValues)  cudaFree(d_activeValues);
    if (d_tiles)         cudaFree(d_tiles);
    if (d_bias)          cudaFree(d_bias);
    if (d_output)        cudaFree(d_output);
    fprintf(stderr, "[CUDA] forward_sparse failed: %s\n", cudaGetErrorString(err));
    return -1;
}

extern "C" int ilaria_cuda_batch_sdr_similarity(
    const uint32_t* querySDR,
    const uint32_t* memorySDRs,
    uint8_t*        results,
    uint32_t        queryWords,
    uint32_t        numMemories
) {
    if (!cuda_initialized) return -1;
    if (numMemories == 0 || queryWords == 0) return 0;

    uint32_t *d_query = NULL, *d_memories = NULL;
    uint8_t  *d_results = NULL;

    size_t queryBytes   = queryWords * sizeof(uint32_t);
    size_t memBytes     = (size_t)numMemories * queryWords * sizeof(uint32_t);
    size_t resultBytes  = numMemories * sizeof(uint8_t);

    cudaError_t err;

    err = cudaMalloc(&d_query, queryBytes);      if (err != cudaSuccess) goto fail2;
    err = cudaMalloc(&d_memories, memBytes);      if (err != cudaSuccess) goto fail2;
    err = cudaMalloc(&d_results, resultBytes);    if (err != cudaSuccess) goto fail2;

    cudaMemcpy(d_query, querySDR, queryBytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_memories, memorySDRs, memBytes, cudaMemcpyHostToDevice);

    {
        int threadsPerBlock = 256;
        int blocks = (numMemories + threadsPerBlock - 1) / threadsPerBlock;
        batch_sdr_similarity_kernel<<<blocks, threadsPerBlock>>>(
            d_query, d_memories, d_results, queryWords, numMemories
        );
    }

    err = cudaGetLastError();
    if (err != cudaSuccess) goto fail2;
    err = cudaDeviceSynchronize();
    if (err != cudaSuccess) goto fail2;

    cudaMemcpy(results, d_results, resultBytes, cudaMemcpyDeviceToHost);

    cudaFree(d_query);
    cudaFree(d_memories);
    cudaFree(d_results);
    return 0;

fail2:
    if (d_query)   cudaFree(d_query);
    if (d_memories) cudaFree(d_memories);
    if (d_results)  cudaFree(d_results);
    fprintf(stderr, "[CUDA] batch_sdr_similarity failed: %s\n", cudaGetErrorString(err));
    return -1;
}
