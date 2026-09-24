//go:build gpu

// audio_whisper_gpu.go — resident fp32 cuBLAS GPU backend for the
// Whisper-small encoder ("ears"), mirroring vision_siglip_gpu.go's
// pattern exactly for the "eyes" tower (same tag as bitnet_gpu.go — this
// file only needs cortex/compute's dynamic cuBLAS bridge, cublas_dyn.go,
// itself gated `gpu && windows`; on a non-Windows `gpu` build
// compute.InitCuBLAS's stub simply errors and EnableWhisperGPU below
// returns that error, same graceful-decline contract as
// EnableSiglipGPU/EnableBitNetGPU).
//
// See audio_whisper.go's audioGPUBackend interface and the
// WhisperEncoderTower.gpu field doc comment for the hook this file
// implements, and audio_whisper_gpu_stub.go for the !gpu build's
// always-erroring stub.
//
// # WHAT GOES ON THE GPU
//
// EnableWhisperGPU uploads BOTH Conv1d layers' weights (Conv1Weight,
// Conv2Weight — conv1dGeluForward already reduces Conv1d to im2col + a
// dense matmul, see that function's doc comment, so no separate conv
// kernel is needed here) plus every encoder layer's six dense matrices
// (Q/K/V/O/FC1/FC2 — NOT the LayerNorm scale/bias or the final
// LayerNorm, which stay on the CPU: per-row reductions over 768/3072
// elements are too small to be worth a round trip, same rationale as
// vision_siglip_gpu.go) as resident fp32 cuBLAS matrices
// (compute.UploadWeight/MatMulResident — the same API
// vision_siglip_gpu.go and transformer_gpu.go already use).
// denseForward's GPU hook (audio_whisper.go) looks the resident handle
// up by the weight slice's own backing-array identity (&w[0]) rather
// than threading a handle through every call site — the tower's weight
// slices are allocated once by NewWhisperEncoderTower and filled in
// place by LoadWhisperEncoderTower's loadF32 (audio_whisper_persist.go),
// so the pointer is stable for the tower's whole lifetime once
// EnableWhisperGPU runs after loading (the normal cmd/ilaria-hear -gpu
// order: load tower, then enable GPU, then Forward).
//
// whisperAttention's GPU hook runs each head's QK^T score matmul and
// softmax@V matmul through cuBLAS too (Attention below), looped over
// the 12 heads rather than batched into one big strided-batched call —
// mirroring siglipGPUBackend.Attention exactly (see that method's doc
// comment for the per-call-overhead rationale), even though Whisper's
// T=1500 is larger than SigLIP2's T=1024 (1500x1500 scores per head is
// ~9 MB fp32 — still a single cudaMemcpy well under the PCIe-overhead
// knee this design accepts). Softmax is computed on the CPU between the
// two GEMMs (accumulating in float64, matching the CPU path's own
// reduction — see audio_whisper.go's whisperAttention doc comment)
// since it is comparatively cheap next to either matmul and doing it on
// the GPU would need a third kernel this file doesn't have.
//
// # WHY THE PROJECTOR NEVER USES THIS BACKEND
//
// AudioProjector.Forward always passes gpu=nil to denseForward (see
// that method) — it runs on only ceil(1500/8)=188 stacked tokens (the
// tower's T=1500 frame tokens, reduced 8x by StackFrames), so its two
// Linear layers are already sub-millisecond on the CPU; uploading its
// weights and paying a round trip would not pay for itself, and the
// task only asked for the tower's conv1d/q/k/v/o/fc1/fc2 and attention
// matmuls to move to the GPU — same rationale as
// vision_siglip_gpu.go's own "WHY THE PROJECTOR NEVER USES THIS
// BACKEND" section.
//
// # MEMORY CHECK
//
// The whisper-small encoder's weights are ~352 MB fp32 (the file this
// task's fixtures export, data/forge/ears/whisper_small_encoder.nxtf,
// is exactly that size) — noticeably larger than SigLIP2's tower, and
// this machine's GPU is often shared with another process (see
// AGENTS.md / the task's own hardware note), so EnableWhisperGPU checks
// compute.DeviceMemInfo's free byte count against the total it is about
// to upload before uploading anything, and fails cleanly (no partial
// upload — nothing is uploaded at all) if there isn't enough headroom.
// If the meminfo query itself errors (e.g. the CUDA driver-API context
// underlying DeviceMemInfo fails to initialize for some reason even
// though the cudart/cublas dynamic bridge above succeeded), the upload
// proceeds anyway rather than refusing outright — matching every other
// meminfo use in this codebase (cmd/ilaria-see, cmd/bitnet-run), which
// treats it as a best-effort report, not a hard prerequisite; only a
// SUCCESSFUL query reporting insufficient free memory is a hard
// failure, per the task's explicit requirement.
//
// # NUMERICS
//
// The CPU tower accumulates every reduction (dense matmuls, attention
// scores/softmax/weighted-sum, LayerNorm) in float64 specifically
// because of massive-activation outlier channels (see audio_whisper_
// test.go's whisperMaxAbsTol doc comment) — cuBLAS's fp32 SGEMM
// accumulates in fp32 instead, which is a real precision downgrade on
// this specific model, exactly as vision_siglip_gpu.go's own doc
// comment describes for SigLIP2. The GPU/CPU equivalence numbers this
// produces (max|Δ| and relative L2 at every captured stage, plus the
// projector's max|Δ|) are measured by TestWhisperGPUTowerMatchesCPU /
// TestWhisperGPUTinySynthetic (audio_whisper_gpu_test.go) against the
// same NEXUS_EARS_DIR fixtures TestWhisperEquivalence /
// TestWhisperTinySynthetic (audio_whisper_test.go) use, checked against
// the SAME tolerances (whisperMaxAbsTol/whisperRelL2Tol/
// whisperLogMelTol) the CPU path uses, and reported in this task's
// final report rather than asserted here as a fixed bound.
package cortex

import (
	"fmt"
	"math"

	"nexus-cortex/cortex/compute"
)

// whisperGPUBackend implements audioGPUBackend with resident fp32
// cuBLAS GEMMs — structurally identical to vision_siglip_gpu.go's
// siglipGPUBackend (see that type's doc comment for the
// handle-by-backing-array-identity rationale this duplicates), kept as
// its own type rather than shared so the eyes/ears GPU backends stay
// independent, matching audioGPUBackend's own doc comment.
type whisperGPUBackend struct {
	handles map[*float32]int
	all     []int // every uploaded handle, in upload order, for teardown
}

// Dense implements audioGPUBackend.Dense — identical to
// siglipGPUBackend.Dense (vision_siglip_gpu.go).
func (b *whisperGPUBackend) Dense(x [][]float32, w, bias []float32, in, out int) ([][]float32, bool) {
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

// Attention implements audioGPUBackend.Attention: per head, scores =
// Q_h @ K_h^T * scale (compute.MatMulNTGPU), softmax on the CPU
// (float64 accumulation), then out_h = softmax @ V_h (compute.MatMulGPU)
// — identical algorithm to siglipGPUBackend.Attention
// (vision_siglip_gpu.go), just at Whisper's own T=1500/heads=12/
// headDim=64 shape instead of SigLIP2's T=1024/heads=16/headDim=72 (or
// whatever the loaded config declares — both towers pass their own
// runtime T/heads/headDim through, this method has no hardcoded shape).
func (b *whisperGPUBackend) Attention(q, k, v [][]float32, heads, headDim int) ([][]float32, bool) {
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

// whisperGPUWeightBytes returns the total byte count EnableWhisperGPU is
// about to upload for tower — both conv weights plus every layer's six
// dense matrices (the same set EnableWhisperGPU's upload loop below
// walks) — used for the pre-upload free-memory check (see file doc
// comment's "MEMORY CHECK" section).
func whisperGPUWeightBytes(tower *WhisperEncoderTower) int64 {
	n := int64(len(tower.Conv1Weight)) + int64(len(tower.Conv2Weight))
	for _, layer := range tower.Layers {
		n += int64(len(layer.QWeight)) + int64(len(layer.KWeight)) + int64(len(layer.VWeight)) +
			int64(len(layer.OWeight)) + int64(len(layer.FC1Weight)) + int64(len(layer.FC2Weight))
	}
	return n * 4 // float32
}

// EnableWhisperGPU uploads tower's two Conv1d weights and every encoder
// layer's six dense matrices to the GPU as resident fp32 cuBLAS matrices
// and attaches a GPU backend, so subsequent tower.Forward/ForwardDebug
// calls route those matmuls — plus the attention score/value matmuls —
// through cuBLAS (see file doc comment). Idempotent-ish like
// EnableSiglipGPU/EnableBitNetGPU: calling it twice re-inits cuBLAS (a
// no-op after the first call) but uploads a second, separate copy of
// every weight — callers should call it once, matching cmd/ilaria-hear's
// -gpu usage. On any upload failure (including a reported low-memory
// condition), whatever made it up for this call is freed and tower.gpu
// is left however it was before the call (nil, on a fresh tower).
func EnableWhisperGPU(tower *WhisperEncoderTower) error {
	if err := compute.InitCuBLAS(); err != nil {
		return fmt.Errorf("cuBLAS init: %w", err)
	}

	need := whisperGPUWeightBytes(tower)
	if free, _, err := compute.DeviceMemInfo(); err == nil {
		// 64 MiB of headroom for cublas_dyn.go's reusable scratch
		// buffers (g_bufA/B/C, sized for the largest single matmul this
		// tower issues — the 1500x1500 attention score matrix is ~9 MB
		// fp32) plus whatever else is resident on the device already.
		const headroom = 64 << 20
		if free < uint64(need)+headroom {
			return fmt.Errorf("not enough free GPU memory: need ~%.0f MiB (+ %.0f MiB headroom), have %.0f MiB free",
				float64(need)/(1<<20), float64(headroom)/(1<<20), float64(free)/(1<<20))
		}
	}
	// A failed meminfo query is not itself fatal — see file doc
	// comment's "MEMORY CHECK" section.

	b := &whisperGPUBackend{handles: make(map[*float32]int)}
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

	if err := upload(tower.Conv1Weight); err != nil {
		teardown()
		return fmt.Errorf("conv1 weight upload: %w", err)
	}
	if err := upload(tower.Conv2Weight); err != nil {
		teardown()
		return fmt.Errorf("conv2 weight upload: %w", err)
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

// DisableWhisperGPU frees every GPU-resident weight EnableWhisperGPU
// uploaded for tower and detaches the backend, reverting all subsequent
// Forward/ForwardDebug calls to the CPU path. No-op if tower.gpu isn't a
// *whisperGPUBackend (e.g. never enabled).
func DisableWhisperGPU(tower *WhisperEncoderTower) {
	impl, ok := tower.gpu.(*whisperGPUBackend)
	if !ok || impl == nil {
		return
	}
	for _, h := range impl.all {
		compute.FreeWeight(h)
	}
	tower.gpu = nil
}
