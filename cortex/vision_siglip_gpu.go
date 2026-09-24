//go:build gpu

// vision_siglip_gpu.go — resident fp32 cuBLAS GPU backend for the SigLIP2
// vision tower (build tag: gpu; same tag as bitnet_gpu.go — this file only
// needs cortex/compute's dynamic cuBLAS bridge, cublas_dyn.go, which is
// itself gated `gpu && windows`; on a non-Windows `gpu` build
// compute.InitCuBLAS's stub simply errors and EnableSiglipGPU below
// returns that error, same graceful-decline contract as EnableBitNetGPU).
//
// See vision_siglip.go's visionGPUBackend interface and the SiglipVisionTower.gpu
// field doc comment for the hook this file implements, and
// vision_siglip_gpu_stub.go for the !gpu build's always-erroring stub.
//
// # WHAT GOES ON THE GPU
//
// EnableSiglipGPU uploads the tower's patch-embedding weight and every
// encoder layer's six dense matrices (Q/K/V/O/FC1/FC2 — NOT the
// LayerNorm scale/bias, which stay on the CPU: per-row reductions over
// 768/3072 elements are too small to be worth a round trip) as resident
// fp32 cuBLAS matrices (compute.UploadWeight/MatMulResident — the same
// API transformer_gpu.go already uses for MiniTransformer generation).
// denseForward's GPU hook (vision_siglip.go) looks the resident handle
// up by the weight slice's own backing-array identity (&w[0]) rather
// than threading a handle through every call site — the tower's weight
// slices are allocated once by NewSiglipVisionTower and filled in place
// by LoadSiglipVisionTower's loadF32 (vision_siglip_persist.go), so the
// pointer is stable for the tower's whole lifetime once EnableSiglipGPU
// runs after loading (the normal cmd/ilaria-see -gpu order: load tower,
// then enable GPU, then Forward).
//
// siglipAttention's GPU hook runs each head's QK^T score matmul and
// softmax@V matmul through cuBLAS too (Attention below), looped over
// the 12 heads rather than batched into one big strided-batched call —
// simpler, and at 1024x1024x64 per head the per-call fixed overhead
// (memcpy H2D/D2H, ~256 KB each way) is small next to the GEMM itself.
// Softmax is computed on the CPU between the two GEMMs (accumulating in
// float64, matching the CPU path's own reduction — see
// vision_siglip.go's siglipAttention doc comment) since it is a cheap
// T*T=1M-element pass compared to either matmul and doing it on the GPU
// would need a third kernel this file doesn't have.
//
// # WHY THE PROJECTOR NEVER USES THIS BACKEND
//
// SiglipProjector.Forward always passes gpu=nil to denseForward (see
// that method) — it runs on only 121 pixel-shuffled tokens (the tower's
// T=1024 patch tokens, reduced 9x), so its two Linear layers are already
// sub-millisecond on the CPU; uploading its ~18 MB of weights and paying
// a round trip would not pay for itself, and the task only asked for the
// tower's patch-embed/q/k/v/o/fc1/fc2 and attention matmuls to move to
// the GPU.
//
// # NUMERICS
//
// The CPU tower accumulates every reduction (dense matmuls, attention
// scores/softmax/weighted-sum, LayerNorm) in float64 specifically
// because of massive-activation outlier channels (see denseForward's own
// doc comment) — cuBLAS's fp32 SGEMM accumulates in fp32 instead, which
// is a real precision downgrade on this specific model. The GPU/CPU
// equivalence numbers this produces (max|Δ| and relative L2 of the full
// tower output, plus the projector's max|Δ|) are measured by
// TestSiglipGPUTowerMatchesCPU (vision_siglip_gpu_test.go) against the
// same NEXUS_EYES_DIR fixture TestSigLIPEquivalence
// (vision_siglip_test.go) uses, and reported in this task's final
// report rather than asserted here as a fixed bound — see that test's
// doc comment for why.
package cortex

import (
	"fmt"
	"math"

	"nexus-cortex/cortex/compute"
)

// siglipGPUBackend implements visionGPUBackend with resident fp32 cuBLAS
// GEMMs. handles maps a weight slice's backing-array identity (&w[0]) to
// its resident cuBLAS handle — see file doc comment for why identity
// rather than an explicit handle parameter.
type siglipGPUBackend struct {
	handles map[*float32]int
	all     []int // every uploaded handle, in upload order, for teardown
}

// Dense implements visionGPUBackend.Dense.
func (b *siglipGPUBackend) Dense(x [][]float32, w, bias []float32, in, out int) ([][]float32, bool) {
	if len(x) == 0 || len(w) == 0 {
		return nil, false
	}
	handle, ok := b.handles[&w[0]]
	if !ok {
		return nil, false // weight never uploaded (e.g. the projector) — CPU path
	}

	T := len(x)
	flatX := make([]float32, T*in)
	for t, row := range x {
		copy(flatX[t*in:(t+1)*in], row)
	}
	flatY := make([]float32, T*out)
	if err := compute.MatMulResident(handle, flatX, T, out, in, false, flatY); err != nil {
		return nil, false // mid-run CUDA error — degrade to CPU, never abort
	}

	y := make([][]float32, T)
	for t := 0; t < T; t++ {
		row := flatY[t*out : (t+1)*out]
		for j := 0; j < out; j++ {
			row[j] += bias[j]
		}
		y[t] = row
	}
	return y, true
}

// Attention implements visionGPUBackend.Attention: per head, scores =
// Q_h @ K_h^T * scale (compute.MatMulNTGPU), softmax on the CPU
// (float64 accumulation), then out_h = softmax @ V_h (compute.MatMulGPU)
// — see file doc comment.
func (b *siglipGPUBackend) Attention(q, k, v [][]float32, heads, headDim int) ([][]float32, bool) {
	T := len(q)
	if T == 0 {
		return nil, false
	}
	hidden := heads * headDim
	out := make([][]float32, T)
	for t := range out {
		out[t] = make([]float32, hidden)
	}

	scale := float32(1.0 / math.Sqrt(float64(headDim)))
	qh := make([]float32, T*headDim)
	kh := make([]float32, T*headDim)
	vh := make([]float32, T*headDim)
	probs := make([]float32, T*T)

	for h := 0; h < heads; h++ {
		off := h * headDim
		for t := 0; t < T; t++ {
			copy(qh[t*headDim:(t+1)*headDim], q[t][off:off+headDim])
			copy(kh[t*headDim:(t+1)*headDim], k[t][off:off+headDim])
			copy(vh[t*headDim:(t+1)*headDim], v[t][off:off+headDim])
		}

		scores, err := compute.MatMulNTGPU(qh, kh, T, T, headDim) // [T,T] = Q_h @ K_h^T
		if err != nil {
			return nil, false
		}

		for t := 0; t < T; t++ {
			row := scores[t*T : (t+1)*T]
			maxScore := math.Inf(-1)
			for _, s := range row {
				d := float64(s) * float64(scale)
				if d > maxScore {
					maxScore = d
				}
			}
			var sum float64
			prow := probs[t*T : (t+1)*T]
			for i, s := range row {
				e := math.Exp(float64(s)*float64(scale) - maxScore)
				prow[i] = float32(e)
				sum += e
			}
			inv := float32(1 / sum)
			for i := range prow {
				prow[i] *= inv
			}
		}

		weighted, err := compute.MatMulGPU(probs, vh, T, headDim, T) // [T,headDim] = softmax @ V_h
		if err != nil {
			return nil, false
		}
		for t := 0; t < T; t++ {
			copy(out[t][off:off+headDim], weighted[t*headDim:(t+1)*headDim])
		}
	}

	return out, true
}

// EnableSiglipGPU uploads tower's patch-embedding weight and every
// encoder layer's six dense matrices to the GPU as resident fp32 cuBLAS
// matrices and attaches a GPU backend, so subsequent tower.Forward calls
// route those matmuls — plus the attention score/value matmuls — through
// cuBLAS (see file doc comment). Idempotent-ish like EnableBitNetGPU:
// calling it twice re-inits cuBLAS (a no-op after the first call) but
// uploads a second, separate copy of every weight — callers should call
// it once, matching cmd/ilaria-see's usage. On any upload failure,
// whatever made it up for this call is freed and tower.gpu is left
// however it was before the call (nil, on a fresh tower).
func EnableSiglipGPU(tower *SiglipVisionTower) error {
	if err := compute.InitCuBLAS(); err != nil {
		return fmt.Errorf("cuBLAS init: %w", err)
	}

	b := &siglipGPUBackend{handles: make(map[*float32]int)}
	teardown := func() {
		for _, h := range b.all {
			compute.FreeWeight(h)
		}
	}
	upload := func(w []float32) error {
		if len(w) == 0 {
			return fmt.Errorf("empty weight")
		}
		h, err := compute.UploadWeight(w)
		if err != nil {
			return err
		}
		b.handles[&w[0]] = h
		b.all = append(b.all, h)
		return nil
	}

	if err := upload(tower.PatchEmbedWeight); err != nil {
		teardown()
		return fmt.Errorf("patch embed upload: %w", err)
	}
	for li, layer := range tower.Layers {
		for _, w := range [][]float32{
			layer.QWeight, layer.KWeight, layer.VWeight, layer.OWeight,
			layer.FC1Weight, layer.FC2Weight,
		} {
			if err := upload(w); err != nil {
				teardown()
				return fmt.Errorf("layer %d dense upload: %w", li, err)
			}
		}
	}

	tower.gpu = b
	return nil
}

// DisableSiglipGPU frees every GPU-resident weight EnableSiglipGPU
// uploaded for tower and detaches the backend, reverting all subsequent
// Forward calls to the CPU path. No-op if tower.gpu isn't a
// *siglipGPUBackend (e.g. never enabled).
func DisableSiglipGPU(tower *SiglipVisionTower) {
	impl, ok := tower.gpu.(*siglipGPUBackend)
	if !ok || impl == nil {
		return
	}
	for _, h := range impl.all {
		compute.FreeWeight(h)
	}
	tower.gpu = nil
}
