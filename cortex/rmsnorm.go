package cortex

import "math"

// rmsnorm.go — a small, allocation-simple RMSNorm helper shared by the
// BitNet engine (cortex/bitnet.go, cortex/bitnet_linear.go). Deliberately
// NOT wired into cortex/transformer*.go's own LayerNorm path — this is an
// additive helper only, per the BitNet task's scope (do not touch existing
// transformer behaviour).

// RMSNorm applies Root-Mean-Square normalization (no bias, no mean
// centering) to a single vector x, weighted elementwise by weight. It
// mirrors transformers.models.bitnet.modeling_bitnet.BitNetRMSNorm.forward
// (also documented there as "equivalent to T5LayerNorm"):
//
//	variance = mean(x_i^2)                 // computed in float64 here,
//	                                        // matching HF's float32 upcast
//	                                        // before the reduction
//	y_i = weight_i * x_i / sqrt(variance + eps)
//
// len(weight) must equal len(x). Returns a freshly allocated slice; x is
// not mutated.
func RMSNorm(x, weight []float32, eps float64) []float32 {
	var sumSq float64
	for _, v := range x {
		f := float64(v)
		sumSq += f * f
	}
	variance := sumSq / float64(len(x))
	invStd := 1.0 / math.Sqrt(variance+eps)

	out := make([]float32, len(x))
	for i, v := range x {
		out[i] = weight[i] * float32(float64(v)*invStd)
	}
	return out
}
