package cortex

import (
	"math"
	"math/rand"
)

// ─────────────────────────────────────────────────────────────────────
// Mini Transformer — Autoregressive Language Model
// ─────────────────────────────────────────────────────────────────────
//
// A minimal but complete GPT-style transformer implementing:
//   - Multi-head causal self-attention
//   - Feed-forward network (FFN) with GELU activation
//   - Pre-norm architecture (LayerNorm before attention and FFN)
//   - Learned token + positional embeddings
//   - Autoregressive generation with temperature sampling
//
// This is the neural core of Broca 2.0. It replaces the associative
// chain walker with a real language model that computes P(next|context).

// TransformerConfig holds hyperparameters for the transformer model.
type TransformerConfig struct {
	VocabSize  int `json:"vocab_size"`   // Tokenizer vocabulary size
	EmbedDim   int `json:"embed_dim"`    // Hidden dimension (d_model)
	NumHeads   int `json:"num_heads"`    // Number of attention heads
	NumLayers  int `json:"num_layers"`   // Number of transformer blocks
	FFNDim     int `json:"ffn_dim"`      // Feed-forward inner dimension (typically 4×EmbedDim)
	MaxSeqLen  int `json:"max_seq_len"`  // Maximum sequence length
	EOSTokenID int `json:"eos_token_id"` // End-of-sequence token ID (default 3)
}

// Notă: nu există DefaultEOSTokenID aici. Sursa unică de adevăr pentru
// EOS token este Config.TransformerEOSTokenID (vezi cortex/config.go).
// TransformerConfig.EOSTokenID este populat din acel câmp la construire.

// DefaultTransformerConfig returns a small but functional config (~13M params).
// Delegates to TransformerConfigFromConfig using DefaultConfig() to avoid
// duplicated hardcoded values.
func DefaultTransformerConfig(vocabSize int) TransformerConfig {
	return TransformerConfigFromConfig(vocabSize, DefaultConfig())
}

// TransformerConfigFromConfig creates a TransformerConfig using values from the
// central Config, allowing all hyperparameters to be overridden via JSON config.
func TransformerConfigFromConfig(vocabSize int, cfg Config) TransformerConfig {
	return TransformerConfig{
		VocabSize:  vocabSize,
		EmbedDim:   cfg.TransformerEmbedDim,
		NumHeads:   cfg.TransformerNumHeads,
		NumLayers:  cfg.TransformerNumLayers,
		FFNDim:     cfg.TransformerFFNDim,
		MaxSeqLen:  cfg.TransformerMaxSeqLen,
		EOSTokenID: cfg.TransformerEOSTokenID,
	}
}

// ─────────────────────────────────────────────────────────────────────
// Multi-Head Self-Attention
// ─────────────────────────────────────────────────────────────────────

// MultiHeadAttention implements scaled dot-product attention with
// multiple heads. Uses causal masking for autoregressive generation.
type MultiHeadAttention struct {
	WQ *Tensor // [EmbedDim, EmbedDim]
	WK *Tensor // [EmbedDim, EmbedDim]
	WV *Tensor // [EmbedDim, EmbedDim]
	WO *Tensor // [EmbedDim, EmbedDim]

	BQ *Tensor // [EmbedDim]
	BK *Tensor // [EmbedDim]
	BV *Tensor // [EmbedDim]
	BO *Tensor // [EmbedDim]

	NumHeads int
	HeadDim  int

	// Gradient accumulators
	WQGrad, WKGrad, WVGrad, WOGrad *Tensor
	BQGrad, BKGrad, BVGrad, BOGrad *Tensor

	// Cached values for backward pass
	lastInput           *Tensor
	lastQ, lastK, lastV *Tensor
	lastAttnWeights     *Tensor
	lastAttnOut         *Tensor

	// Per-head scratch buffers reused across heads and across consecutive
	// Forward calls. None of these are referenced by lastQ/lastK/etc, so
	// they're safe to reuse between Forward invocations.
	qhBuf, khBuf, vhBuf *Tensor // [seqLen, headDim]
	scoresBuf           *Tensor // [seqLen, seqLen]
	headOutBuf          *Tensor // [seqLen, headDim]

	// Scratch slices for the single-token cached generation path. Grown
	// to headDim and the current cache length respectively.
	stepQhBuf     []float32 // [headDim]
	stepScoresBuf []float32 // [cacheSeqLen]

	// Scratch tensors for the single-token cached generation path, all
	// [1, embedDim]. Allocated lazily on first ForwardCachedStep call.
	// Reused across consecutive steps; safe because the cache path has no
	// backward and the per-step outputs are fully overwritten each call.
	stepQBuf, stepKBuf, stepVBuf *Tensor // [1, embedDim] Q/K/V projection
	stepAttnBuf                  *Tensor // [1, embedDim] per-step attn aggregate
	stepOutBuf                   *Tensor // [1, embedDim] WO projection output

	// gpu carries resident-weight handles for the cached step path.
	// Nil = CPU matmuls. Set by MiniTransformer.EnableGPUGeneration.
	gpu *mhaGPU
}

// ensureMatrix returns t if it already has the requested 2D shape,
// otherwise allocates a fresh tensor. Used by the per-head scratch
// fields to grow with seqLen on first use (and on the rare resize).
func ensureMatrix(t *Tensor, rows, cols int) *Tensor {
	if t != nil && len(t.Shape) == 2 && t.Shape[0] == rows && t.Shape[1] == cols {
		return t
	}
	return NewTensor(rows, cols)
}

// NewMultiHeadAttention creates attention with Xavier-initialized weights.
func NewMultiHeadAttention(embedDim, numHeads int, rng *rand.Rand) *MultiHeadAttention {
	headDim := embedDim / numHeads
	std := float32(1.0 / math.Sqrt(float64(embedDim)))

	mha := &MultiHeadAttention{
		WQ: NewTensorRand(rng, std, embedDim, embedDim),
		WK: NewTensorRand(rng, std, embedDim, embedDim),
		WV: NewTensorRand(rng, std, embedDim, embedDim),
		WO: NewTensorRand(rng, std, embedDim, embedDim),

		BQ: NewTensor(embedDim),
		BK: NewTensor(embedDim),
		BV: NewTensor(embedDim),
		BO: NewTensor(embedDim),

		NumHeads: numHeads,
		HeadDim:  headDim,

		WQGrad: NewTensor(embedDim, embedDim),
		WKGrad: NewTensor(embedDim, embedDim),
		WVGrad: NewTensor(embedDim, embedDim),
		WOGrad: NewTensor(embedDim, embedDim),

		BQGrad: NewTensor(embedDim),
		BKGrad: NewTensor(embedDim),
		BVGrad: NewTensor(embedDim),
		BOGrad: NewTensor(embedDim),
	}
	return mha
}

// Forward computes multi-head causal self-attention.
// Input: x [seqLen, embedDim]
// Output: [seqLen, embedDim]
func (mha *MultiHeadAttention) Forward(x *Tensor) *Tensor {
	seqLen := x.Shape[0]
	embedDim := x.Shape[1]
	numHeads := mha.NumHeads
	headDim := mha.HeadDim

	// Cache input for backward
	mha.lastInput = x

	// Project Q, K, V: [seqLen, embedDim] × [embedDim, embedDim] = [seqLen, embedDim].
	// MatMul returns a fresh tensor, so the bias add is safe in place.
	Q := x.MatMul(mha.WQ)
	Q.AddInPlace(mha.BQ)
	K := x.MatMul(mha.WK)
	K.AddInPlace(mha.BK)
	V := x.MatMul(mha.WV)
	V.AddInPlace(mha.BV)

	mha.lastQ = Q
	mha.lastK = K
	mha.lastV = V

	// Scale factor
	scale := float32(1.0 / math.Sqrt(float64(headDim)))

	// Output accumulator
	attnOut := NewTensor(seqLen, embedDim)

	// Process each head separately
	// (Could be optimized by reshaping, but this is clearer)
	allWeights := NewTensor(numHeads, seqLen, seqLen)

	// Lazy-allocate per-head scratch buffers; reused across heads and
	// across consecutive Forward calls (none escape into mha.last*).
	mha.qhBuf = ensureMatrix(mha.qhBuf, seqLen, headDim)
	mha.khBuf = ensureMatrix(mha.khBuf, seqLen, headDim)
	mha.vhBuf = ensureMatrix(mha.vhBuf, seqLen, headDim)
	mha.scoresBuf = ensureMatrix(mha.scoresBuf, seqLen, seqLen)
	mha.headOutBuf = ensureMatrix(mha.headOutBuf, seqLen, headDim)
	Qh, Kh, Vh := mha.qhBuf, mha.khBuf, mha.vhBuf
	scores := mha.scoresBuf
	headOut := mha.headOutBuf

	for h := 0; h < numHeads; h++ {
		hStart := h * headDim

		// Extract head slices into the reused [seqLen, headDim] buffers.
		for i := 0; i < seqLen; i++ {
			for j := 0; j < headDim; j++ {
				Qh.Data[i*headDim+j] = Q.Data[i*embedDim+hStart+j]
				Kh.Data[i*headDim+j] = K.Data[i*embedDim+hStart+j]
				Vh.Data[i*headDim+j] = V.Data[i*embedDim+hStart+j]
			}
		}

		// Attention scores into scores buffer: [seqLen, seqLen] = Q_h × K_h^T / sqrt(headDim).
		Qh.MatMulTransposedInto(scores, Kh)
		scores.ScaleInPlace(scale)

		// Causal mask: set future positions to -inf
		for i := 0; i < seqLen; i++ {
			for j := i + 1; j < seqLen; j++ {
				scores.Data[i*seqLen+j] = float32(math.Inf(-1))
			}
		}

		// Softmax in place on the scores buffer.
		scores.SoftmaxInPlace()

		// Save weights for backward (copy needed: scores is recycled next head).
		copy(allWeights.Data[h*seqLen*seqLen:], scores.Data)

		// Weighted sum into headOut buffer: [seqLen, headDim] = scores × V_h
		scores.MatMulInto(headOut, Vh)

		// Write head output to the correct slice of attnOut
		for i := 0; i < seqLen; i++ {
			for j := 0; j < headDim; j++ {
				attnOut.Data[i*embedDim+hStart+j] = headOut.Data[i*headDim+j]
			}
		}
	}

	mha.lastAttnWeights = allWeights

	// Output projection: [seqLen, embedDim] × [embedDim, embedDim].
	output := attnOut.MatMul(mha.WO)
	output.AddInPlace(mha.BO)
	mha.lastAttnOut = attnOut

	return output
}

// ZeroGrad resets all gradient accumulators.
func (mha *MultiHeadAttention) ZeroGrad() {
	mha.WQGrad.Zeros()
	mha.WKGrad.Zeros()
	mha.WVGrad.Zeros()
	mha.WOGrad.Zeros()
	mha.BQGrad.Zeros()
	mha.BKGrad.Zeros()
	mha.BVGrad.Zeros()
	mha.BOGrad.Zeros()
}

// ─────────────────────────────────────────────────────────────────────
// Feed-Forward Network
// ─────────────────────────────────────────────────────────────────────

// FeedForward is a two-layer MLP with GELU activation.
// FFN(x) = GELU(x·W1 + b1)·W2 + b2
type FeedForward struct {
	W1 *Tensor // [EmbedDim, FFNDim]
	B1 *Tensor // [FFNDim]
	W2 *Tensor // [FFNDim, EmbedDim]
	B2 *Tensor // [EmbedDim]

	// Gradients
	W1Grad, W2Grad *Tensor
	B1Grad, B2Grad *Tensor

	// Cached for backward
	lastInput  *Tensor
	lastHidden *Tensor // pre-activation
	lastAct    *Tensor // post-GELU

	// Scratch tensors for the cached generation path. stepHiddenBuf is
	// [1, ffnDim] (also doubles as the post-GELU activation, see
	// ForwardCachedStep); stepOutBuf is [1, embedDim]. Cache path has no
	// backward, so we don't need separate pre/post-activation tensors.
	stepHiddenBuf *Tensor // [1, ffnDim]
	stepOutBuf    *Tensor // [1, embedDim]

	// gpu carries resident-weight handles for the cached step path.
	// Nil = CPU matmuls. Set by MiniTransformer.EnableGPUGeneration.
	gpu *ffnGPU
}

// NewFeedForward creates a feed-forward network with Xavier initialization.
func NewFeedForward(embedDim, ffnDim int, rng *rand.Rand) *FeedForward {
	std1 := float32(1.0 / math.Sqrt(float64(embedDim)))
	std2 := float32(1.0 / math.Sqrt(float64(ffnDim)))

	return &FeedForward{
		W1: NewTensorRand(rng, std1, embedDim, ffnDim),
		B1: NewTensor(ffnDim),
		W2: NewTensorRand(rng, std2, ffnDim, embedDim),
		B2: NewTensor(embedDim),

		W1Grad: NewTensor(embedDim, ffnDim),
		B1Grad: NewTensor(ffnDim),
		W2Grad: NewTensor(ffnDim, embedDim),
		B2Grad: NewTensor(embedDim),
	}
}

// Forward computes FFN(x) = GELU(x·W1 + b1)·W2 + b2.
func (ff *FeedForward) Forward(x *Tensor) *Tensor {
	ff.lastInput = x

	// MatMul gives a fresh tensor, so the bias add can be in place.
	hidden := x.MatMul(ff.W1)
	hidden.AddInPlace(ff.B1)
	ff.lastHidden = hidden

	// GELU must produce a separate tensor: backward needs both lastHidden
	// (pre-activation) and lastAct (post-activation).
	activated := hidden.GELU()
	ff.lastAct = activated

	output := activated.MatMul(ff.W2)
	output.AddInPlace(ff.B2)
	return output
}

// ZeroGrad resets gradients.
func (ff *FeedForward) ZeroGrad() {
	ff.W1Grad.Zeros()
	ff.B1Grad.Zeros()
	ff.W2Grad.Zeros()
	ff.B2Grad.Zeros()
}

// ─────────────────────────────────────────────────────────────────────
// Transformer Block
// ─────────────────────────────────────────────────────────────────────

// TransformerBlock is a single transformer layer with pre-norm architecture:
//
//	x = x + Attention(LayerNorm(x))
//	x = x + FFN(LayerNorm(x))
type TransformerBlock struct {
	Attn *MultiHeadAttention
	FFN  *FeedForward

	LN1Gamma *Tensor // [EmbedDim]
	LN1Beta  *Tensor // [EmbedDim]
	LN2Gamma *Tensor // [EmbedDim]
	LN2Beta  *Tensor // [EmbedDim]

	// LayerNorm gradient accumulators (filled by Backward).
	LN1GammaGrad *Tensor
	LN1BetaGrad  *Tensor
	LN2GammaGrad *Tensor
	LN2BetaGrad  *Tensor

	// Cached for backward
	lastInput   *Tensor
	lastNormed1 *Tensor // x → LN1 → normed1 (input to Attn)
	lastNormed2 *Tensor // (x+attnOut) → LN2 → normed2 (input to FFN)
	lastResid1  *Tensor // x + attnOut (input to LN2)
	// LayerNorm forward statistics needed for backward: per-row mean and
	// inverse stddev, sized [seqLen]. ln1Mean[i] / ln1InvStd[i] correspond
	// to row i of lastInput; ln2Mean[i] / ln2InvStd[i] correspond to row i
	// of lastResid1. Filled by Forward (when training is active), consumed
	// by Backward.
	ln1Mean, ln1InvStd []float32
	ln2Mean, ln2InvStd []float32

	// Scratch tensors for the cached generation path, [1, embedDim] each.
	stepNormed1Buf, stepNormed2Buf *Tensor
}

// NewTransformerBlock creates a transformer block.
func NewTransformerBlock(embedDim, numHeads, ffnDim int, rng *rand.Rand) *TransformerBlock {
	ln1g := NewTensor(embedDim)
	ln1b := NewTensor(embedDim)
	ln2g := NewTensor(embedDim)
	ln2b := NewTensor(embedDim)

	// Initialize LayerNorm gamma to 1
	for i := range ln1g.Data {
		ln1g.Data[i] = 1.0
		ln2g.Data[i] = 1.0
	}

	return &TransformerBlock{
		Attn:         NewMultiHeadAttention(embedDim, numHeads, rng),
		FFN:          NewFeedForward(embedDim, ffnDim, rng),
		LN1Gamma:     ln1g,
		LN1Beta:      ln1b,
		LN2Gamma:     ln2g,
		LN2Beta:      ln2b,
		LN1GammaGrad: NewTensor(embedDim),
		LN1BetaGrad:  NewTensor(embedDim),
		LN2GammaGrad: NewTensor(embedDim),
		LN2BetaGrad:  NewTensor(embedDim),
	}
}

// Forward processes a sequence through the transformer block.
// Input: [seqLen, embedDim]
// Output: [seqLen, embedDim]
func (tb *TransformerBlock) Forward(x *Tensor) *Tensor {
	tb.lastInput = x

	// Pre-norm attention with residual.
	// attnOut is a fresh tensor; fold x into it in place to avoid a Clone.
	// Important: do NOT mutate x — tb.lastInput still references it.
	normed1 := x.LayerNorm(tb.LN1Gamma, tb.LN1Beta)
	tb.lastNormed1 = normed1
	attnOut := tb.Attn.Forward(normed1)
	attnOut.AddInPlace(x)
	x = attnOut

	// Pre-norm FFN with residual (same in-place trick on ffnOut).
	normed2 := x.LayerNorm(tb.LN2Gamma, tb.LN2Beta)
	tb.lastNormed2 = normed2
	ffnOut := tb.FFN.Forward(normed2)
	ffnOut.AddInPlace(x)
	x = ffnOut

	return x
}

// ZeroGrad resets all gradients in the block.
func (tb *TransformerBlock) ZeroGrad() {
	tb.Attn.ZeroGrad()
	tb.FFN.ZeroGrad()
	tb.LN1GammaGrad.Zeros()
	tb.LN1BetaGrad.Zeros()
	tb.LN2GammaGrad.Zeros()
	tb.LN2BetaGrad.Zeros()
}

// ─────────────────────────────────────────────────────────────────────
// Mini Transformer (full model)
// ─────────────────────────────────────────────────────────────────────

// MiniTransformer is the complete autoregressive language model.
type MiniTransformer struct {
	Config    TransformerConfig
	Embedding *EmbeddingTable
	Blocks    []*TransformerBlock

	// Final layer norm
	LNFGamma *Tensor // [EmbedDim]
	LNFBeta  *Tensor // [EmbedDim]

	// LayerNorm-final gradient accumulators.
	LNFGammaGrad *Tensor
	LNFBetaGrad  *Tensor

	// LM Head: projects hidden states to vocabulary logits
	// Shares weights with embedding (weight tying)
	// lmHead = Embedding.TokenEmb transposed → [EmbedDim, VocabSize]
	UseTiedWeights bool

	// Cached hidden state from last Forward() for use in TrainStep.
	// lastPreLNF is the input to the final LayerNorm; lastHiddenState
	// is the output (after LNF). Both are needed for backward.
	lastPreLNF         *Tensor
	lastHiddenState    *Tensor
	lnfMean, lnfInvStd []float32

	// gpu holds resident-weight handles for GPU generation. Nil = CPU
	// path. Populated by EnableGPUGeneration (transformer_gpu.go); the
	// cached step functions consult it per matmul with CPU fallback.
	gpu *gpuResidentState

	Rng *rand.Rand
}

// NewMiniTransformer creates a fresh transformer language model.
func NewMiniTransformer(cfg TransformerConfig, rng *rand.Rand) *MiniTransformer {
	emb := NewEmbeddingTable(cfg.VocabSize, cfg.EmbedDim, cfg.MaxSeqLen, rng)

	blocks := make([]*TransformerBlock, cfg.NumLayers)
	for i := 0; i < cfg.NumLayers; i++ {
		blocks[i] = NewTransformerBlock(cfg.EmbedDim, cfg.NumHeads, cfg.FFNDim, rng)
	}

	lnfg := NewTensor(cfg.EmbedDim)
	lnfb := NewTensor(cfg.EmbedDim)
	for i := range lnfg.Data {
		lnfg.Data[i] = 1.0
	}

	return &MiniTransformer{
		Config:         cfg,
		Embedding:      emb,
		Blocks:         blocks,
		LNFGamma:       lnfg,
		LNFBeta:        lnfb,
		LNFGammaGrad:   NewTensor(cfg.EmbedDim),
		LNFBetaGrad:    NewTensor(cfg.EmbedDim),
		UseTiedWeights: true,
		Rng:            rng,
	}
}

// Forward runs the full model forward pass.
// Input: tokenIDs []int (length seqLen)
// Output: logits *Tensor [seqLen, VocabSize]
func (m *MiniTransformer) Forward(tokenIDs []int) *Tensor {
	// 1. Embedding lookup: [seqLen, EmbedDim]
	x := m.Embedding.Forward(tokenIDs)

	// 2. Transformer blocks
	for _, block := range m.Blocks {
		x = block.Forward(x)
	}

	// 3. Final layer norm
	x = x.LayerNorm(m.LNFGamma, m.LNFBeta)

	// Cache the hidden state for TrainStep (avoids double forward pass)
	m.lastHiddenState = x

	// 4. LM Head: project to vocabulary
	// With weight tying: logits = x × TokenEmb^T
	// Tied weights: reuse token embeddings as the LM head.
	// UseTiedWeights is always true; a separate LMHead matrix
	// would be needed here if untied weights are ever supported.
	logits := x.MatMulTransposed(m.Embedding.TokenEmb)

	return logits
}

// TrainStep performs one forward+backward+update step with plain SGD.
// Input: tokenIDs for a training sequence (the target is shifted by 1).
// Returns the loss value.
//
// Deprecated: prefer TrainStepAdam/TrainStepAdamBatch, which add momentum,
// bias correction and gradient clipping. TrainStep remains as the simplest
// entry point and delegates to full backpropagation.
//
// History: until 2026-09 this method updated embeddings only and applied
// GAUSSIAN NOISE to every attention/FFN weight ("perturbation training").
// Any call on a trained checkpoint therefore actively corrupted it. The
// noise path was removed; real backprop is now the only behaviour.
func (m *MiniTransformer) TrainStep(tokenIDs []int, lr float32) float32 {
	return m.TrainStepBackprop(tokenIDs, lr)
}

// ─────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────

// Generate produces tokens autoregressively from a prompt.
// Uses temperature-scaled sampling with top-k filtering.
func (m *MiniTransformer) Generate(prompt []int, maxNewTokens int, temperature float32, topK int) []int {
	if temperature <= 0 {
		temperature = 1.0
	}
	if topK <= 0 {
		topK = m.Config.VocabSize // greedy: consider entire vocab
	}

	generated := make([]int, len(prompt))
	copy(generated, prompt)

	for i := 0; i < maxNewTokens; i++ {
		// Truncate to max sequence length
		input := generated
		if len(input) > m.Config.MaxSeqLen {
			input = input[len(input)-m.Config.MaxSeqLen:]
		}

		// Forward pass
		logits := m.Forward(input)

		// Get logits for the last position
		lastPos := logits.Shape[0] - 1
		vocabSize := logits.Shape[1]
		lastLogits := make([]float32, vocabSize)
		copy(lastLogits, logits.Data[lastPos*vocabSize:(lastPos+1)*vocabSize])

		// Temperature scaling
		for j := range lastLogits {
			lastLogits[j] /= temperature
		}

		// Top-k filtering
		nextToken := topKSample(lastLogits, topK, m.Rng)
		generated = append(generated, nextToken)

		// Stop at EOS
		eosID := m.Config.EOSTokenID
		if nextToken == eosID {
			break
		}
	}

	return generated
}

// topKSample samples from the top-k logits using softmax probabilities.
func topKSample(logits []float32, k int, rng *rand.Rand) int {
	n := len(logits)
	if k > n {
		k = n
	}

	// Find top-k indices
	type indexedVal struct {
		idx int
		val float32
	}

	// Partial sort: find top k values
	topK := make([]indexedVal, 0, k)
	for i, v := range logits {
		if len(topK) < k {
			topK = append(topK, indexedVal{i, v})
			// Bubble up
			for j := len(topK) - 1; j > 0; j-- {
				if topK[j].val > topK[j-1].val {
					topK[j], topK[j-1] = topK[j-1], topK[j]
				}
			}
		} else if v > topK[k-1].val {
			topK[k-1] = indexedVal{i, v}
			// Bubble up
			for j := k - 1; j > 0; j-- {
				if topK[j].val > topK[j-1].val {
					topK[j], topK[j-1] = topK[j-1], topK[j]
				}
			}
		}
	}

	// Softmax over top-k
	maxVal := topK[0].val
	probs := make([]float32, len(topK))
	sum := float32(0)
	for i, iv := range topK {
		p := float32(math.Exp(float64(iv.val - maxVal)))
		probs[i] = p
		sum += p
	}
	for i := range probs {
		probs[i] /= sum
	}

	// Sample
	r := rng.Float32()
	cumulative := float32(0)
	for i, p := range probs {
		cumulative += p
		if r < cumulative {
			return topK[i].idx
		}
	}

	return topK[0].idx
}

// ParamCount returns the total trainable parameter count.
func (m *MiniTransformer) ParamCount() int {
	count := m.Embedding.ParamCount()

	for range m.Blocks {
		// Attention: 4 × [EmbedDim, EmbedDim] weight matrices + 4 × [EmbedDim] biases
		d := m.Config.EmbedDim
		count += 4*d*d + 4*d

		// FFN: W1[EmbedDim, FFNDim] + B1[FFNDim] + W2[FFNDim, EmbedDim] + B2[EmbedDim]
		count += d*m.Config.FFNDim + m.Config.FFNDim + m.Config.FFNDim*d + d

		// LayerNorm: 2 × (gamma[EmbedDim] + beta[EmbedDim])
		count += 4 * d
	}

	// Final LN
	count += 2 * m.Config.EmbedDim

	return count
}
