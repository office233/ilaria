package cortex

// tensor_gpu_resident.go — resident TRAINING weights.
//
// THE PROBLEM: the training matmuls route through tensor.go's GPU
// offload, which copies BOTH operands per call. The weight matrices are
// the same few tensors thousands of times per step, so training spends
// most of its GPU wall time re-uploading unchanged weights over PCIe —
// cursa E′ measured ~12 s/step on a 17.7M model because of it.
//
// THE FIX: a process-global registry mapping weight *Tensor → resident
// device handle. MatMulInto / MatMulTransposedInto consult it for their
// B operand and use the resident GEMM (only activations cross PCIe).
// The optimizer mutates weights every step, so AdamState.Apply calls
// RefreshResidentWeights afterwards — one bulk memcpy of ~4 bytes/param
// (tens of ms for tens of millions of params) instead of per-matmul
// re-uploads.
//
// Registration is explicit (EnableGPUTraining) and keyed by pointer
// identity: a tensor REPLACED (not mutated) by a load path simply stops
// matching and falls back to the copy path — stale-data bugs are
// structurally impossible, the worst case is losing the speedup.

import (
	"fmt"
	"sync"

	"nexus-cortex/cortex/compute"
)

var (
	residentMu      sync.RWMutex
	residentHandles map[*Tensor]int
)

// residentHandleFor returns the device handle for a registered weight.
func residentHandleFor(t *Tensor) (int, bool) {
	residentMu.RLock()
	h, ok := residentHandles[t]
	residentMu.RUnlock()
	return h, ok
}

// trainingWeights lists every matrix the training matmuls consume as a
// B operand (forward projections, dX backward via W^T, tied LM head).
func (m *MiniTransformer) trainingWeights() []*Tensor {
	ws := []*Tensor{m.Embedding.TokenEmb}
	for _, b := range m.Blocks {
		ws = append(ws, b.Attn.WQ, b.Attn.WK, b.Attn.WV, b.Attn.WO,
			b.FFN.W1, b.FFN.W2)
		if b.FFN.W3 != nil {
			ws = append(ws, b.FFN.W3)
		}
	}
	return ws
}

// EnableGPUTraining uploads every training weight matrix to the GPU and
// registers it for resident matmuls. Requires a -tags gpu (or cuda)
// build with a working device; call DisableGPUTraining to tear down.
func (m *MiniTransformer) EnableGPUTraining() error {
	if err := compute.InitCuBLAS(); err != nil {
		return fmt.Errorf("cuBLAS init: %w", err)
	}
	residentMu.Lock()
	defer residentMu.Unlock()
	if residentHandles == nil {
		residentHandles = make(map[*Tensor]int)
	}
	for _, w := range m.trainingWeights() {
		if _, dup := residentHandles[w]; dup {
			continue
		}
		h, err := compute.UploadWeight(w.Data)
		if err != nil {
			return fmt.Errorf("upload training weight: %w", err)
		}
		residentHandles[w] = h
	}
	return nil
}

// DisableGPUTraining frees this model's resident training weights.
func (m *MiniTransformer) DisableGPUTraining() {
	residentMu.Lock()
	defer residentMu.Unlock()
	for _, w := range m.trainingWeights() {
		if h, ok := residentHandles[w]; ok {
			compute.FreeWeight(h)
			delete(residentHandles, w)
		}
	}
}

// RefreshResidentWeights pushes the current host values of every
// registered weight back to the device. Called by AdamState.Apply after
// each optimizer step; a failed refresh unregisters the weight so a
// stale device copy can never be used.
func (m *MiniTransformer) RefreshResidentWeights() {
	residentMu.Lock()
	defer residentMu.Unlock()
	if len(residentHandles) == 0 {
		return
	}
	for _, w := range m.trainingWeights() {
		h, ok := residentHandles[w]
		if !ok {
			continue
		}
		if err := compute.UpdateWeight(h, w.Data); err != nil {
			compute.FreeWeight(h)
			delete(residentHandles, w)
		}
	}
}

// gpuTrainingActive reports whether any training weights are resident
// (cheap check used by Apply to skip the refresh entirely).
func gpuTrainingActive() bool {
	residentMu.RLock()
	n := len(residentHandles)
	residentMu.RUnlock()
	return n > 0
}
