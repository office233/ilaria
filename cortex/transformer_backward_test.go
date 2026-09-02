package cortex

import (
	"math"
	"math/rand"
	"testing"
)

// gradCheck verifies that the analytic gradient stored in `paramGrad`
// matches the numeric gradient obtained by perturbing `param` by ±eps
// and recomputing the loss. Returns the max absolute and max relative
// error across all elements.
//
// lossFn must return the current loss using the *current* parameter
// values (it is called repeatedly with mutated parameters).
//
// Used only in tests — keeps the production code free of test helpers.
func gradCheck(t *testing.T, name string, param, paramGrad *Tensor, lossFn func() float32, eps float32, maxRel, maxAbs float32) {
	t.Helper()
	for i := range param.Data {
		original := param.Data[i]

		param.Data[i] = original + eps
		lPos := lossFn()
		param.Data[i] = original - eps
		lNeg := lossFn()
		param.Data[i] = original

		numeric := (lPos - lNeg) / (2 * eps)
		analytic := paramGrad.Data[i]

		absErr := float32(math.Abs(float64(numeric - analytic)))
		den := float32(math.Abs(float64(numeric))) + float32(math.Abs(float64(analytic))) + 1e-8
		relErr := absErr / den

		if absErr > maxAbs && relErr > maxRel {
			t.Errorf("%s[%d]: numeric=%.6f analytic=%.6f absErr=%.6f relErr=%.6f",
				name, i, numeric, analytic, absErr, relErr)
			// Don't spam too many failures.
			if i > 8 {
				t.Fatalf("aborting %s after too many mismatches", name)
			}
		}
	}
}

// buildTinyTransformer creates a minuscule transformer suitable for
// gradient checking — small enough that numeric grad over every param
// finishes in well under a second, but exercises every layer type.
// Optional mutators adjust the config before construction (used to
// gradcheck the RoPE/SwiGLU variants with the same machinery).
func buildTinyTransformer(mutate ...func(*TransformerConfig)) (*MiniTransformer, []int) {
	rng := rand.New(rand.NewSource(1))
	cfg := TransformerConfig{
		VocabSize:  20,
		EmbedDim:   8,
		NumHeads:   2,
		NumLayers:  1,
		FFNDim:     16,
		MaxSeqLen:  8,
		EOSTokenID: 3,
	}
	for _, f := range mutate {
		f(&cfg)
	}
	m := NewMiniTransformer(cfg, rng)
	// Deterministic short input (seqLen=6 → 5 train positions).
	tokens := []int{2, 5, 11, 7, 4, 9}
	return m, tokens
}

// TestTransformerGradCheck verifies the entire backward pass against
// finite-difference numeric gradients. If any analytic gradient diverges
// from the numeric one, training cannot converge, so this is the single
// most important test for the backward implementation.
func TestTransformerGradCheck(t *testing.T) {
	m, tokens := buildTinyTransformer()
	runFullGradCheck(t, m, tokens)
}

// TestTransformerGradCheck_RoPESwiGLU runs the identical
// finite-difference validation with rotary positions and the gated
// SiLU FFN enabled — the config planned for from-scratch training
// (cursa E'). Every analytic path touched by the new architecture
// (rotation backward, gate product, SiLU derivative, W3/B3 grads) is
// covered by the same machinery that validated the GPT-2 form.
func TestTransformerGradCheck_RoPESwiGLU(t *testing.T) {
	m, tokens := buildTinyTransformer(func(c *TransformerConfig) {
		c.UseRoPE = true
		c.UseSwiGLU = true
	})
	if m.Blocks[0].FFN.W3 == nil {
		t.Fatal("SwiGLU gate not allocated")
	}
	if m.Embedding.AddPositional {
		t.Fatal("PosEmb still active under RoPE")
	}
	runFullGradCheck(t, m, tokens)
}

func runFullGradCheck(t *testing.T, m *MiniTransformer, tokens []int) {
	t.Helper()

	// Run one TrainStepBackprop with lr=0 so gradients populate but
	// parameters do NOT move. This way every subsequent numeric
	// perturbation runs against the same weights.
	loss := m.TrainStepBackprop(tokens, 0)
	if math.IsNaN(float64(loss)) || math.IsInf(float64(loss), 0) {
		t.Fatalf("loss is not finite: %v", loss)
	}

	// Build a loss-only closure for numeric grads. ForwardTrain mutates
	// the lastHiddenState / lnf statistics caches but does NOT touch
	// gradients, so calling it inside the closure is safe.
	input := tokens[:len(tokens)-1]
	target := tokens[1:]
	lossFn := func() float32 {
		logits := m.ForwardTrain(input)
		return CrossEntropyLoss(logits, target)
	}

	const eps float32 = 1e-3
	const maxRel float32 = 1e-2
	const maxAbs float32 = 1e-3

	// Block 0 weights — the most likely to have bugs.
	b := m.Blocks[0]
	gradCheck(t, "FFN.W2", b.FFN.W2, b.FFN.W2Grad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "FFN.B2", b.FFN.B2, b.FFN.B2Grad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "FFN.W1", b.FFN.W1, b.FFN.W1Grad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "FFN.B1", b.FFN.B1, b.FFN.B1Grad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.WO", b.Attn.WO, b.Attn.WOGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.WQ", b.Attn.WQ, b.Attn.WQGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.WK", b.Attn.WK, b.Attn.WKGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.WV", b.Attn.WV, b.Attn.WVGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.BO", b.Attn.BO, b.Attn.BOGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.BQ", b.Attn.BQ, b.Attn.BQGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.BK", b.Attn.BK, b.Attn.BKGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "Attn.BV", b.Attn.BV, b.Attn.BVGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "LN1Gamma", b.LN1Gamma, b.LN1GammaGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "LN1Beta", b.LN1Beta, b.LN1BetaGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "LN2Gamma", b.LN2Gamma, b.LN2GammaGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "LN2Beta", b.LN2Beta, b.LN2BetaGrad, lossFn, eps, maxRel, maxAbs)

	gradCheck(t, "LNFGamma", m.LNFGamma, m.LNFGammaGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "LNFBeta", m.LNFBeta, m.LNFBetaGrad, lossFn, eps, maxRel, maxAbs)

	// SwiGLU gate projection (when present).
	if b.FFN.W3 != nil {
		gradCheck(t, "FFN.W3", b.FFN.W3, b.FFN.W3Grad, lossFn, eps, maxRel, maxAbs)
		gradCheck(t, "FFN.B3", b.FFN.B3, b.FFN.B3Grad, lossFn, eps, maxRel, maxAbs)
	}

	// Embedding weights — token embedding gets gradients from two paths
	// (LM head tie + embedding lookup), positional embedding only from
	// the lookup path (and not at all under RoPE, where its numeric
	// gradient is provably zero and the check still holds).
	gradCheck(t, "TokenEmb", m.Embedding.TokenEmb, m.Embedding.TokenEmbGrad, lossFn, eps, maxRel, maxAbs)
	gradCheck(t, "PosEmb", m.Embedding.PosEmb, m.Embedding.PosEmbGrad, lossFn, eps, maxRel, maxAbs)
}

// TestTrainStepBackpropOverfit confirms the new backward implementation
// can actually drive the loss down. We pick a single short sequence and
// repeatedly call TrainStepBackprop; loss should drop from ~ln(vocab) to
// well below 1 after a few hundred steps. This is the integration check
// that complements the per-parameter gradient check above.
func TestTrainStepBackpropOverfit(t *testing.T) {
	m, tokens := buildTinyTransformer()

	initial := m.TrainStepBackprop(tokens, 0) // measures loss without moving weights
	final := initial
	for i := 0; i < 400; i++ {
		final = m.TrainStepBackprop(tokens, 0.05)
	}

	if final >= initial*0.5 {
		t.Fatalf("loss did not drop enough: initial=%.4f final=%.4f", initial, final)
	}
	if final >= 1.0 {
		t.Fatalf("loss did not converge below 1.0 on tiny overfit: final=%.4f", final)
	}
	t.Logf("overfit loss: initial=%.4f final=%.4f", initial, final)
}
