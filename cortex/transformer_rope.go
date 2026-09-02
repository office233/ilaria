package cortex

// transformer_rope.go — Rotary Position Embeddings (RoPE, Su et al.),
// config-gated via TransformerConfig.UseRoPE.
//
// WHY CONFIG-GATED AND OFF BY DEFAULT: the imported GPT-2-family
// checkpoints were trained with learned absolute positions — enabling
// RoPE under them would scramble their attention. RoPE is for models
// trained from scratch in Nexus (cursa E′+), where it removes the
// learned position table and the hard MaxSeqLen extrapolation wall.
//
// MECHANICS: each head's Q and K rows are rotated pairwise by a
// position-dependent angle right after projection (+bias). Because the
// rotation is orthogonal and applied identically to Q and K, the score
// Q_i·K_j depends on (i−j) — relative position — instead of absolute
// indices. The backward pass is the transpose: rotate the incoming
// dQ/dK by the INVERSE angle before the projection-weight gradients.
//
// CACHE CONVENTION: rotated K is what enters the KV cache (both the
// batched prefill, which copies lastK, and the single-token step append
// see post-rotation values), so cached-vs-training equivalence holds
// with no per-step recomputation of past rows.

import "math"

// ropeBase is the standard RoPE frequency base. 10000 matches the
// original paper and virtually every open model; not worth a config
// knob until someone needs long-context scaling (NTK/YaRN territory).
const ropeBase = 10000.0

// applyRoPE rotates t's rows in place. t is [rows, embedDim] laid out
// as numHeads contiguous slices of headDim; row r sits at absolute
// position posOffset+r. inverse applies the transpose rotation (used by
// backward).
func applyRoPE(t *Tensor, numHeads, headDim, posOffset int, inverse bool) {
	rows := t.Shape[0]
	embedDim := t.Shape[1]
	half := headDim / 2

	for r := 0; r < rows; r++ {
		pos := float64(posOffset + r)
		rowOff := r * embedDim
		for j := 0; j < half; j++ {
			theta := pos * math.Pow(ropeBase, -2*float64(j)/float64(headDim))
			sin, cos := math.Sincos(theta)
			if inverse {
				sin = -sin
			}
			s, c := float32(sin), float32(cos)
			for h := 0; h < numHeads; h++ {
				i0 := rowOff + h*headDim + 2*j
				x0, x1 := t.Data[i0], t.Data[i0+1]
				t.Data[i0] = x0*c - x1*s
				t.Data[i0+1] = x0*s + x1*c
			}
		}
	}
}
