package cortex

// transformer_optimizer.go — Adam optimizer with bias correction and
// gradient clipping for the MiniTransformer, plus learning-rate
// schedules (linear warmup + cosine decay).
//
// Plain SGD (sgdUpdate in transformer_backward.go) trains correctly but
// converges painfully slow at the sparse-gradient corners of a vocab —
// most tokens are rarely seen, so SGD effectively makes one tiny step
// per appearance. Adam normalises each parameter's update by a running
// estimate of its gradient magnitude, which lets rare-token embeddings
// keep up with the common ones.

import "math"

// AdamConfig holds the hyperparameters for Adam.
type AdamConfig struct {
	Beta1   float32 // 1st-moment decay (default 0.9)
	Beta2   float32 // 2nd-moment decay (default 0.999)
	Epsilon float32 // numerical stability (default 1e-8)
	// MaxGradNorm clips the global L2 norm of all parameter gradients
	// to this value before the update. <=0 disables clipping. 1.0 is a
	// reasonable default for small transformers.
	MaxGradNorm float32
	// WeightDecay is AdamW-style DECOUPLED decay (Loshchilov & Hutter):
	// w -= lr·wd·w applied directly to the parameter, never mixed into
	// the gradient/moment estimates. Applied only to weight MATRICES —
	// embeddings, attention and FFN projections — and never to biases
	// or LayerNorm parameters, which regularising drags toward a
	// degenerate identity-less normalisation. 0 disables (default,
	// preserving pre-AdamW behaviour). Typical: 0.01–0.1.
	WeightDecay float32
}

// DefaultAdamConfig returns sensible defaults for a small transformer.
// Sursa de adevăr este DefaultConfig() (vezi cortex/config.go câmpurile
// Adam*). Modificare prin JSON config = fără recompilare.
func DefaultAdamConfig() AdamConfig {
	return AdamConfigFromConfig(DefaultConfig())
}

// AdamConfigFromConfig extrage hyperparametrii Adam dintr-un Config
// general. Permite trainer-ului să folosească aceleași valori încărcate
// din JSON ca restul organismului.
func AdamConfigFromConfig(c Config) AdamConfig {
	return AdamConfig{
		Beta1:       c.AdamBeta1,
		Beta2:       c.AdamBeta2,
		Epsilon:     c.AdamEpsilon,
		MaxGradNorm: c.AdamMaxGradNorm,
		WeightDecay: c.AdamWeightDecay,
	}
}

// AdamState holds the first/second moment buffers for every trainable
// tensor in a MiniTransformer, plus the step counter used for bias
// correction. Build one via NewAdamState(m) and reuse it across calls.
type AdamState struct {
	Cfg  AdamConfig
	Step int

	// Embedding
	TokenEmbM, TokenEmbV *Tensor
	PosEmbM, PosEmbV     *Tensor

	// Per-block buffers
	Blocks []adamBlockState

	// Final LN
	LNFGammaM, LNFGammaV *Tensor
	LNFBetaM, LNFBetaV   *Tensor

	// LastGradNorm holds the pre-clip global L2 norm of the gradients
	// from the most recent Apply call. Diagnostic only; not persisted.
	LastGradNorm float32 `json:"-"`
}

type adamBlockState struct {
	LN1GammaM, LN1GammaV *Tensor
	LN1BetaM, LN1BetaV   *Tensor
	LN2GammaM, LN2GammaV *Tensor
	LN2BetaM, LN2BetaV   *Tensor

	WQM, WQV *Tensor
	WKM, WKV *Tensor
	WVM, WVV *Tensor
	WOM, WOV *Tensor
	BQM, BQV *Tensor
	BKM, BKV *Tensor
	BVM, BVV *Tensor
	BOM, BOV *Tensor

	W1M, W1V *Tensor
	B1M, B1V *Tensor
	W2M, W2V *Tensor
	B2M, B2V *Tensor
}

// NewAdamState allocates moment buffers shaped to match m. Cheap; do it
// once per training run.
func NewAdamState(m *MiniTransformer, cfg AdamConfig) *AdamState {
	zero := func(t *Tensor) *Tensor { return NewTensor(t.Shape...) }
	s := &AdamState{
		Cfg:       cfg,
		TokenEmbM: zero(m.Embedding.TokenEmb),
		TokenEmbV: zero(m.Embedding.TokenEmb),
		PosEmbM:   zero(m.Embedding.PosEmb),
		PosEmbV:   zero(m.Embedding.PosEmb),
		LNFGammaM: zero(m.LNFGamma),
		LNFGammaV: zero(m.LNFGamma),
		LNFBetaM:  zero(m.LNFBeta),
		LNFBetaV:  zero(m.LNFBeta),
		Blocks:    make([]adamBlockState, len(m.Blocks)),
	}
	for i, b := range m.Blocks {
		s.Blocks[i] = adamBlockState{
			LN1GammaM: zero(b.LN1Gamma), LN1GammaV: zero(b.LN1Gamma),
			LN1BetaM: zero(b.LN1Beta), LN1BetaV: zero(b.LN1Beta),
			LN2GammaM: zero(b.LN2Gamma), LN2GammaV: zero(b.LN2Gamma),
			LN2BetaM: zero(b.LN2Beta), LN2BetaV: zero(b.LN2Beta),
			WQM: zero(b.Attn.WQ), WQV: zero(b.Attn.WQ),
			WKM: zero(b.Attn.WK), WKV: zero(b.Attn.WK),
			WVM: zero(b.Attn.WV), WVV: zero(b.Attn.WV),
			WOM: zero(b.Attn.WO), WOV: zero(b.Attn.WO),
			BQM: zero(b.Attn.BQ), BQV: zero(b.Attn.BQ),
			BKM: zero(b.Attn.BK), BKV: zero(b.Attn.BK),
			BVM: zero(b.Attn.BV), BVV: zero(b.Attn.BV),
			BOM: zero(b.Attn.BO), BOV: zero(b.Attn.BO),
			W1M: zero(b.FFN.W1), W1V: zero(b.FFN.W1),
			B1M: zero(b.FFN.B1), B1V: zero(b.FFN.B1),
			W2M: zero(b.FFN.W2), W2V: zero(b.FFN.W2),
			B2M: zero(b.FFN.B2), B2V: zero(b.FFN.B2),
		}
	}
	return s
}

// gradGlobalNorm returns the L2 norm of the concatenation of every
// parameter gradient in m. Cheap diagnostic — call it right before
// optimizer.Apply if you want to log it.
func gradGlobalNorm(m *MiniTransformer) float32 {
	sumSq := float64(0)
	addSq := func(t *Tensor) {
		for _, v := range t.Data {
			sumSq += float64(v) * float64(v)
		}
	}
	addSq(m.Embedding.TokenEmbGrad)
	addSq(m.Embedding.PosEmbGrad)
	addSq(m.LNFGammaGrad)
	addSq(m.LNFBetaGrad)
	for _, b := range m.Blocks {
		addSq(b.LN1GammaGrad)
		addSq(b.LN1BetaGrad)
		addSq(b.LN2GammaGrad)
		addSq(b.LN2BetaGrad)
		addSq(b.Attn.WQGrad)
		addSq(b.Attn.WKGrad)
		addSq(b.Attn.WVGrad)
		addSq(b.Attn.WOGrad)
		addSq(b.Attn.BQGrad)
		addSq(b.Attn.BKGrad)
		addSq(b.Attn.BVGrad)
		addSq(b.Attn.BOGrad)
		addSq(b.FFN.W1Grad)
		addSq(b.FFN.B1Grad)
		addSq(b.FFN.W2Grad)
		addSq(b.FFN.B2Grad)
	}
	return float32(math.Sqrt(sumSq))
}

// GradGlobalNorm exposes gradGlobalNorm to callers outside the package
// (e.g. the trainer wants to log it).
func (m *MiniTransformer) GradGlobalNorm() float32 { return gradGlobalNorm(m) }

// clipGradients rescales every parameter gradient by min(1, maxNorm /
// total_L2_norm) so the global update step stays bounded. Mirrors the
// torch.nn.utils.clip_grad_norm_ behaviour. No-op when maxNorm<=0.
// Returns the pre-clip global L2 norm so the caller can log it.
func clipGradients(m *MiniTransformer, maxNorm float32) float32 {
	norm := gradGlobalNorm(m)
	if maxNorm <= 0 || norm <= maxNorm {
		return norm
	}
	scale := maxNorm / norm
	scaleTensor := func(t *Tensor) {
		for i := range t.Data {
			t.Data[i] *= scale
		}
	}
	scaleTensor(m.Embedding.TokenEmbGrad)
	scaleTensor(m.Embedding.PosEmbGrad)
	scaleTensor(m.LNFGammaGrad)
	scaleTensor(m.LNFBetaGrad)
	for _, b := range m.Blocks {
		scaleTensor(b.LN1GammaGrad)
		scaleTensor(b.LN1BetaGrad)
		scaleTensor(b.LN2GammaGrad)
		scaleTensor(b.LN2BetaGrad)
		scaleTensor(b.Attn.WQGrad)
		scaleTensor(b.Attn.WKGrad)
		scaleTensor(b.Attn.WVGrad)
		scaleTensor(b.Attn.WOGrad)
		scaleTensor(b.Attn.BQGrad)
		scaleTensor(b.Attn.BKGrad)
		scaleTensor(b.Attn.BVGrad)
		scaleTensor(b.Attn.BOGrad)
		scaleTensor(b.FFN.W1Grad)
		scaleTensor(b.FFN.B1Grad)
		scaleTensor(b.FFN.W2Grad)
		scaleTensor(b.FFN.B2Grad)
	}
	return norm
}

// adamUpdate applies one Adam step to (w, g) using the moment buffers
// (mState, vState). All four tensors share the same shape. lr is the
// already-scheduled learning rate; bias correction uses step.
func adamUpdate(w, g, mState, vState *Tensor, lr float32, cfg AdamConfig, step int) {
	adamUpdateWD(w, g, mState, vState, lr, cfg, step, 0)
}

// adamUpdateWD is adamUpdate plus AdamW decoupled weight decay at rate
// wd (0 = plain Adam). Decay is applied straight to the parameter,
// outside the moment estimates — folding it into the gradient (classic
// L2) would let the adaptive scaling shrink the decay exactly where
// weights are large, defeating its purpose.
func adamUpdateWD(w, g, mState, vState *Tensor, lr float32, cfg AdamConfig, step int, wd float32) {
	b1 := cfg.Beta1
	b2 := cfg.Beta2
	eps := cfg.Epsilon
	bc1 := float32(1 - math.Pow(float64(b1), float64(step)))
	bc2 := float32(1 - math.Pow(float64(b2), float64(step)))
	decay := lr * wd
	for i := range w.Data {
		gi := g.Data[i]
		mState.Data[i] = b1*mState.Data[i] + (1-b1)*gi
		vState.Data[i] = b2*vState.Data[i] + (1-b2)*gi*gi
		mHat := mState.Data[i] / bc1
		vHat := vState.Data[i] / bc2
		w.Data[i] -= lr*mHat/(float32(math.Sqrt(float64(vHat)))+eps) + decay*w.Data[i]
	}
}

// Apply runs gradient clipping followed by one Adam update over every
// trainable parameter in m. Increments the internal step counter so
// bias-correction terms stay correct across calls. Must be invoked
// AFTER a forward + backward has populated gradient buffers.
func (s *AdamState) Apply(m *MiniTransformer, lr float32) {
	s.Step++
	s.LastGradNorm = clipGradients(m, s.Cfg.MaxGradNorm)

	// Weight decay applies to matrices only — see AdamConfig.WeightDecay.
	wd := s.Cfg.WeightDecay

	// Embedding (matrices — decayed)
	adamUpdateWD(m.Embedding.TokenEmb, m.Embedding.TokenEmbGrad,
		s.TokenEmbM, s.TokenEmbV, lr, s.Cfg, s.Step, wd)
	adamUpdateWD(m.Embedding.PosEmb, m.Embedding.PosEmbGrad,
		s.PosEmbM, s.PosEmbV, lr, s.Cfg, s.Step, wd)

	// Final LN (never decayed)
	adamUpdate(m.LNFGamma, m.LNFGammaGrad, s.LNFGammaM, s.LNFGammaV, lr, s.Cfg, s.Step)
	adamUpdate(m.LNFBeta, m.LNFBetaGrad, s.LNFBetaM, s.LNFBetaV, lr, s.Cfg, s.Step)

	for i, b := range m.Blocks {
		st := &s.Blocks[i]
		adamUpdate(b.LN1Gamma, b.LN1GammaGrad, st.LN1GammaM, st.LN1GammaV, lr, s.Cfg, s.Step)
		adamUpdate(b.LN1Beta, b.LN1BetaGrad, st.LN1BetaM, st.LN1BetaV, lr, s.Cfg, s.Step)
		adamUpdate(b.LN2Gamma, b.LN2GammaGrad, st.LN2GammaM, st.LN2GammaV, lr, s.Cfg, s.Step)
		adamUpdate(b.LN2Beta, b.LN2BetaGrad, st.LN2BetaM, st.LN2BetaV, lr, s.Cfg, s.Step)

		adamUpdateWD(b.Attn.WQ, b.Attn.WQGrad, st.WQM, st.WQV, lr, s.Cfg, s.Step, wd)
		adamUpdateWD(b.Attn.WK, b.Attn.WKGrad, st.WKM, st.WKV, lr, s.Cfg, s.Step, wd)
		adamUpdateWD(b.Attn.WV, b.Attn.WVGrad, st.WVM, st.WVV, lr, s.Cfg, s.Step, wd)
		adamUpdateWD(b.Attn.WO, b.Attn.WOGrad, st.WOM, st.WOV, lr, s.Cfg, s.Step, wd)
		adamUpdate(b.Attn.BQ, b.Attn.BQGrad, st.BQM, st.BQV, lr, s.Cfg, s.Step)
		adamUpdate(b.Attn.BK, b.Attn.BKGrad, st.BKM, st.BKV, lr, s.Cfg, s.Step)
		adamUpdate(b.Attn.BV, b.Attn.BVGrad, st.BVM, st.BVV, lr, s.Cfg, s.Step)
		adamUpdate(b.Attn.BO, b.Attn.BOGrad, st.BOM, st.BOV, lr, s.Cfg, s.Step)

		adamUpdateWD(b.FFN.W1, b.FFN.W1Grad, st.W1M, st.W1V, lr, s.Cfg, s.Step, wd)
		adamUpdate(b.FFN.B1, b.FFN.B1Grad, st.B1M, st.B1V, lr, s.Cfg, s.Step)
		adamUpdateWD(b.FFN.W2, b.FFN.W2Grad, st.W2M, st.W2V, lr, s.Cfg, s.Step, wd)
		adamUpdate(b.FFN.B2, b.FFN.B2Grad, st.B2M, st.B2V, lr, s.Cfg, s.Step)
	}
}

// ─────────────────────────────────────────────────────────────────────
// Learning-rate schedule
// ─────────────────────────────────────────────────────────────────────

// LRSchedule produces a learning rate for a given step. WarmupSteps
// linearly ramps from 0 to PeakLR; the remaining DecaySteps use cosine
// decay down to MinLR. After WarmupSteps+DecaySteps the LR stays at
// MinLR.
type LRSchedule struct {
	WarmupSteps int
	DecaySteps  int
	PeakLR      float32
	MinLR       float32
}

// LR returns the learning rate for the (1-indexed) step. Step 0 is
// treated as step 1 so the first call after Adam.Step++ matches.
func (s LRSchedule) LR(step int) float32 {
	if step <= 0 {
		step = 1
	}
	if step <= s.WarmupSteps {
		return s.PeakLR * float32(step) / float32(maxInt(s.WarmupSteps, 1))
	}
	end := s.WarmupSteps + s.DecaySteps
	if step >= end {
		return s.MinLR
	}
	progress := float64(step-s.WarmupSteps) / float64(maxInt(s.DecaySteps, 1))
	cos := 0.5 * (1 + math.Cos(math.Pi*progress))
	return s.MinLR + (s.PeakLR-s.MinLR)*float32(cos)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ─────────────────────────────────────────────────────────────────────
// Training entry point that uses Adam
// ─────────────────────────────────────────────────────────────────────

// TrainStepAdam runs one full forward + backward step and updates with
// Adam (with bias correction and global-norm clipping). lr is the
// scheduled learning rate for this step.
//
// Loss is the cross-entropy on the sequence.
func (m *MiniTransformer) TrainStepAdam(tokenIDs []int, lr float32, opt *AdamState) float32 {
	if len(tokenIDs) < 2 {
		return 0
	}
	m.zeroAllGrads()
	loss := m.accumulateGrad(tokenIDs)
	opt.Apply(m, lr)
	return loss
}

// TrainStepAdamBatch is the batched / gradient-accumulation variant of
// TrainStepAdam. It runs forward + backward on every sequence in batch
// (each contribution is added into the same gradient buffers), then
// scales the aggregated gradient by 1/len(batch) so the effective
// gradient is the mean — exactly equivalent to backpropagating a single
// padded batch, but cheaper because we don't materialise the padding.
// One Adam update is applied at the end.
//
// Returns the mean per-sequence cross-entropy loss.
//
// Why this matters: 1-sequence updates are extremely noisy because each
// sample's gradient points in a different direction. Averaging across
// 4–16 sequences smooths that noise, lets Adam's second-moment estimate
// stabilise faster, and typically halves the steps needed to hit a
// given loss.
func (m *MiniTransformer) TrainStepAdamBatch(batch [][]int, lr float32, opt *AdamState) float32 {
	if len(batch) == 0 {
		return 0
	}
	m.zeroAllGrads()
	var lossSum float32
	var totalTokens int
	for _, seq := range batch {
		if len(seq) < 2 {
			continue
		}
		// Weight each sequence by its predicted-token count so the
		// final mean is per TOKEN. With uniform lengths this reduces
		// exactly to the old per-sequence mean; with mixed lengths it
		// stops short sequences from dominating the update.
		effLen := len(seq) - 1
		if effLen > m.Config.MaxSeqLen {
			effLen = m.Config.MaxSeqLen
		}
		loss := m.accumulateGradWeighted(seq, float32(effLen))
		lossSum += loss * float32(effLen)
		totalTokens += effLen
	}
	if totalTokens == 0 {
		return 0
	}
	// Scale accumulated (token-weighted) gradients into the per-token
	// mean. Without this, batches would take updates ~batch-size larger
	// than single-sample steps, defeating the noise-reduction purpose.
	inv := 1.0 / float32(totalTokens)
	scaleAllGrads(m, inv)
	opt.Apply(m, lr)
	return lossSum / float32(totalTokens)
}

// accumulateGrad runs one forward + full backward on tokenIDs WITHOUT
// zeroing gradient buffers and WITHOUT applying any optimizer step.
// Used by both TrainStepAdam (which zeros once and applies once) and
// TrainStepAdamBatch (which zeros once, accumulates N times, then
// applies once).
//
// Returns the cross-entropy loss for this sequence.
func (m *MiniTransformer) accumulateGrad(tokenIDs []int) float32 {
	return m.accumulateGradWeighted(tokenIDs, 1)
}

// accumulateGradWeighted is accumulateGrad with the sequence's gradient
// contribution scaled by w. TrainStepAdamBatch passes w = token count
// so the batch mean is per-TOKEN, not per-sequence: dLogits comes back
// from CrossEntropySoftmaxGrad averaged over this sequence's tokens, so
// without the reweighting a 5-token sequence pulls as hard as a
// 500-token one and short sequences dominate training.
func (m *MiniTransformer) accumulateGradWeighted(tokenIDs []int, w float32) float32 {
	seqLen := len(tokenIDs) - 1
	if seqLen > m.Config.MaxSeqLen {
		seqLen = m.Config.MaxSeqLen
	}
	input := tokenIDs[:seqLen]
	target := tokenIDs[1 : seqLen+1]

	logits := m.ForwardTrain(input)
	loss := CrossEntropyLoss(logits, target)
	dLogits := CrossEntropySoftmaxGrad(logits, target)
	if w != 1 {
		// Every downstream buffer is linear in dLogits, so scaling here
		// scales this sequence's entire gradient contribution.
		for i := range dLogits.Data {
			dLogits.Data[i] *= w
		}
	}

	// LM head (tied) — accumulates into TokenEmbGrad, returns dHidden.
	hidden := m.lastHiddenState
	dHidden := dLogits.MatMul(m.Embedding.TokenEmb)
	dTokFromHead := dLogits.Transpose().MatMul(hidden)
	m.Embedding.TokenEmbGrad.AddInPlace(dTokFromHead)

	// Final LayerNorm backward → dPreLNF (accumulates LNF grads inside).
	dPreLNF := layerNormBackward(dHidden, m.lastPreLNF, m.LNFGamma,
		m.lnfMean, m.lnfInvStd, m.LNFGammaGrad, m.LNFBetaGrad)

	// Blocks in reverse.
	dX := dPreLNF
	for i := len(m.Blocks) - 1; i >= 0; i-- {
		dX = m.Blocks[i].Backward(dX)
	}

	// Embedding lookup backward — scatter dX into the rows of TokenEmb
	// and PosEmb corresponding to this input.
	m.Embedding.Backward(dX, input)
	return loss
}

// zeroAllGrads resets every gradient accumulator in the model. Used at
// the start of each optimizer step.
func (m *MiniTransformer) zeroAllGrads() {
	m.Embedding.ZeroGrad()
	for _, b := range m.Blocks {
		b.ZeroGrad()
	}
	m.LNFGammaGrad.Zeros()
	m.LNFBetaGrad.Zeros()
}

// scaleAllGrads multiplies every gradient buffer by s. Used by batch
// accumulation to convert the summed gradient into a mean.
func scaleAllGrads(m *MiniTransformer, s float32) {
	scale := func(t *Tensor) {
		for i := range t.Data {
			t.Data[i] *= s
		}
	}
	scale(m.Embedding.TokenEmbGrad)
	scale(m.Embedding.PosEmbGrad)
	scale(m.LNFGammaGrad)
	scale(m.LNFBetaGrad)
	for _, b := range m.Blocks {
		scale(b.LN1GammaGrad)
		scale(b.LN1BetaGrad)
		scale(b.LN2GammaGrad)
		scale(b.LN2BetaGrad)
		scale(b.Attn.WQGrad)
		scale(b.Attn.WKGrad)
		scale(b.Attn.WVGrad)
		scale(b.Attn.WOGrad)
		scale(b.Attn.BQGrad)
		scale(b.Attn.BKGrad)
		scale(b.Attn.BVGrad)
		scale(b.Attn.BOGrad)
		scale(b.FFN.W1Grad)
		scale(b.FFN.B1Grad)
		scale(b.FFN.W2Grad)
		scale(b.FFN.B2Grad)
	}
}
