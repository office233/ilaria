//go:build cuda
// +build cuda

package compute

/*
#cgo CFLAGS: -I${SRCDIR}/cuda
#cgo LDFLAGS: -L${SRCDIR}/cuda -lcuda_ilaria
#include "cuda_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// CUDAEngine implements the Engine interface using NVIDIA CUDA.
// It provides GPU-accelerated ternary popcount forward passes and
// batch SDR similarity computation.
type CUDAEngine struct {
	cpu      *CPUEngine // CPU fallback for error cases
	deviceID int
}

// NewCUDAEngine creates a new CUDA compute engine targeting device 0.
func NewCUDAEngine() *CUDAEngine {
	return &CUDAEngine{
		cpu:      NewCPUEngine(),
		deviceID: 0,
	}
}

// Init initializes the CUDA device and context.
func (e *CUDAEngine) Init() error {
	ret := C.ilaria_cuda_init(C.int(e.deviceID))
	if ret != 0 {
		return fmt.Errorf("CUDA initialization failed (device %d)", e.deviceID)
	}
	return nil
}

// Close releases CUDA resources.
func (e *CUDAEngine) Close() {
	C.ilaria_cuda_close()
}

// ForwardSparse performs a GPU-accelerated ternary neural layer forward pass.
// On any CUDA error, falls back to CPU transparently.
func (e *CUDAEngine) ForwardSparse(
	activeIndices []uint32,
	activeValues []int16,
	tiles []uint32,
	bias []int16,
	tilesPerRow int,
	outputSize int,
) ([]int16, error) {
	if len(activeIndices) == 0 {
		out := make([]int16, outputSize)
		copy(out, bias)
		return out, nil
	}

	// Validate inputs
	if outputSize <= 0 || tilesPerRow <= 0 {
		return nil, fmt.Errorf("cuda: invalid outputSize=%d or tilesPerRow=%d", outputSize, tilesPerRow)
	}
	if len(activeIndices) != len(activeValues) {
		return nil, fmt.Errorf("cuda: mismatched activeIndices(%d) and activeValues(%d)", len(activeIndices), len(activeValues))
	}

	// Convert int16 arrays to int32 for CUDA kernel
	activeValues32 := make([]int32, len(activeValues))
	for i, v := range activeValues {
		activeValues32[i] = int32(v)
	}
	bias32 := make([]int32, len(bias))
	for i, b := range bias {
		bias32[i] = int32(b)
	}
	output32 := make([]int32, outputSize)

	ret := C.ilaria_cuda_forward_sparse(
		(*C.uint32_t)(unsafe.Pointer(&activeIndices[0])),
		(*C.int32_t)(unsafe.Pointer(&activeValues32[0])),
		C.uint32_t(len(activeIndices)),
		(*C.uint32_t)(unsafe.Pointer(&tiles[0])),
		(*C.int32_t)(unsafe.Pointer(&bias32[0])),
		(*C.int32_t)(unsafe.Pointer(&output32[0])),
		C.uint32_t(tilesPerRow),
		C.uint32_t(outputSize),
	)

	if ret != 0 {
		// CUDA failed — fall back to CPU
		return e.cpu.ForwardSparse(activeIndices, activeValues, tiles, bias, tilesPerRow, outputSize)
	}

	// Convert back to int16
	out16 := make([]int16, outputSize)
	for i, v := range output32 {
		out16[i] = int16(v)
	}
	return out16, nil
}

// BatchSDRSimilarity computes popcount(query & memory[i]) on the GPU.
func (e *CUDAEngine) BatchSDRSimilarity(querySDR []uint32, memorySDRs [][]uint32) ([]uint8, error) {
	if len(memorySDRs) == 0 || len(querySDR) == 0 {
		return nil, nil
	}

	queryWords := len(querySDR)
	numMemories := len(memorySDRs)

	// Flatten memory SDRs into a contiguous array
	flat := make([]uint32, numMemories*queryWords)
	for i, mem := range memorySDRs {
		if len(mem) < queryWords {
			// Pad with zeros
			copy(flat[i*queryWords:], mem)
		} else {
			copy(flat[i*queryWords:], mem[:queryWords])
		}
	}

	results := make([]uint8, numMemories)

	ret := C.ilaria_cuda_batch_sdr_similarity(
		(*C.uint32_t)(unsafe.Pointer(&querySDR[0])),
		(*C.uint32_t)(unsafe.Pointer(&flat[0])),
		(*C.uint8_t)(unsafe.Pointer(&results[0])),
		C.uint32_t(queryWords),
		C.uint32_t(numMemories),
	)

	if ret != 0 {
		// Fall back to CPU
		return e.cpu.BatchSDRSimilarity(querySDR, memorySDRs)
	}

	return results, nil
}
