package cortex

// transformer_gpu.go — resident-weight GPU generation for MiniTransformer.
//
// THE PROBLEM
//
// Token generation is GEMV-bound: every emitted token multiplies a
// [1, d] activation against every weight matrix — for an 82M-param
// model that is ~330 MB of weight reads per token. The pre-existing
// GPU path (tensor.go → compute.MatMulGPU) copies BOTH operands to the
// device per call, so for M=1 it moves those 330 MB across PCIe every
// token — slower than not using the GPU at all. That is why
// gpuMatmulMinFlops never triggers during generation.
//
// THE FIX
//
// Upload the weights ONCE (EnableGPUGeneration), keep them resident in
// VRAM, and per token move only the activation vector up (~3 KB) and
// the result down (≤ 200 KB for the logits). The GPU then reads its own
// HBM at hundreds of GB/s instead of PCIe at ~12 GB/s.
//
// WHAT STAYS ON CPU
//
// Attention scores/softmax/weighted-sum and every bias/LayerNorm/GELU:
// per token these touch KBs, not MBs — moving them would add transfer
// latency for no bandwidth win. Only the six big projections per block
// (WQ WK WV WO W1 W2) and the tied LM head go resident.
//
// FAILURE MODE: every hook falls back to the CPU matmul if the GPU
// call errors, so a mid-run CUDA failure degrades speed, not output.

import (
	"fmt"

	"nexus-cortex/cortex/compute"
)

// mhaGPU holds resident handles for one attention block's projections.
type mhaGPU struct {
	wq, wk, wv, wo int
}

// ffnGPU holds resident handles for one FFN's matrices. w3 is -1 for
// GELU FFNs (no gate projection).
type ffnGPU struct {
	w1, w2, w3 int
}

// gpuResidentState tracks everything EnableGPUGeneration uploaded so
// DisableGPUGeneration can free it, plus the tied-LM-head handle used
// by logitsFromHidden.
type gpuResidentState struct {
	lmHead  int   // TokenEmb resident copy, used transposed
	handles []int // every uploaded handle, for teardown
}

// gpuMatVecInto runs dst[1,N] = x[1,K] × W_resident (optionally
// transposed) and reports success. On any error the caller is expected
// to fall back to the CPU matmul — generation must never die because
// the GPU hiccuped.
func gpuMatVecInto(dst, x *Tensor, handle int, transW bool, n, k int) bool {
	return compute.MatMulResident(handle, x.Data, 1, n, k, transW, dst.Data) == nil
}

// EnableGPUGeneration uploads all generation-path weights to the GPU
// and switches the cached step functions to resident matmuls. Requires
// a binary built with -tags cuda and a successful compute.InitCuBLAS
// (called here). Idempotent: enabling twice re-uses the first upload.
//
// VRAM cost ≈ 4 bytes/param of the block weights + tied head — for
// GPT-2 124M about 500 MB, well inside a 6 GB card.
func (m *MiniTransformer) EnableGPUGeneration() error {
	if m.gpu != nil {
		return nil
	}
	if err := compute.InitCuBLAS(); err != nil {
		return fmt.Errorf("cuBLAS init: %w", err)
	}

	st := &gpuResidentState{lmHead: -1}
	upload := func(t *Tensor) (int, error) {
		h, err := compute.UploadWeight(t.Data)
		if err != nil {
			return -1, err
		}
		st.handles = append(st.handles, h)
		return h, nil
	}
	// On partial failure free whatever made it up — a half-resident
	// model would be slower than either full mode.
	teardown := func() {
		for _, h := range st.handles {
			compute.FreeWeight(h)
		}
	}

	for i, b := range m.Blocks {
		var g mhaGPU
		var err error
		if g.wq, err = upload(b.Attn.WQ); err == nil {
			if g.wk, err = upload(b.Attn.WK); err == nil {
				if g.wv, err = upload(b.Attn.WV); err == nil {
					g.wo, err = upload(b.Attn.WO)
				}
			}
		}
		if err != nil {
			teardown()
			return fmt.Errorf("block %d attention upload: %w", i, err)
		}

		f := ffnGPU{w3: -1}
		if f.w1, err = upload(b.FFN.W1); err == nil {
			f.w2, err = upload(b.FFN.W2)
		}
		if err == nil && b.FFN.W3 != nil {
			f.w3, err = upload(b.FFN.W3)
		}
		if err != nil {
			teardown()
			return fmt.Errorf("block %d FFN upload: %w", i, err)
		}

		b.Attn.gpu = &g
		b.FFN.gpu = &f
	}

	lm, err := upload(m.Embedding.TokenEmb)
	if err != nil {
		for _, b := range m.Blocks {
			b.Attn.gpu, b.FFN.gpu = nil, nil
		}
		teardown()
		return fmt.Errorf("LM head upload: %w", err)
	}
	st.lmHead = lm

	m.gpu = st
	return nil
}

// DisableGPUGeneration frees the resident weights and returns the model
// to pure-CPU generation.
func (m *MiniTransformer) DisableGPUGeneration() {
	if m.gpu == nil {
		return
	}
	for _, b := range m.Blocks {
		b.Attn.gpu = nil
		b.FFN.gpu = nil
	}
	for _, h := range m.gpu.handles {
		compute.FreeWeight(h)
	}
	m.gpu = nil
}

// GPUGenerationEnabled reports whether the resident path is active.
func (m *MiniTransformer) GPUGenerationEnabled() bool {
	return m.gpu != nil
}
