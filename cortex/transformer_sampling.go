package cortex

// transformer_sampling.go — modern sampling for MiniTransformer:
// nucleus (top-p) filtering and repetition penalty, unified behind
// SampleConfig / GenerateSampled.
//
// WHY: temperature+top-k alone loops — the imported DistilGPT-2's very
// first benchmark run produced "…led by former neuroscientist
// Christopher M. M. M. M. M." (a classic top-k failure: once a token
// dominates, nothing discourages picking it again). Repetition penalty
// (CTRL-style) directly damps recently emitted tokens; top-p removes
// the long tail of junk candidates that a fixed k either includes (k
// too big) or crops meaning from (k too small).
//
// The legacy entry points (Generate, GenerateFast, GenerateFastMin,
// GenerateFastBiased) are left byte-for-byte intact — the evalsuite
// history depends on their exact RNG consumption. New callers should
// use GenerateSampled.

import "math"

// SampleConfig collects every sampling knob for GenerateSampled.
// Zero-valued fields fall back to sane behaviour (see normalise).
type SampleConfig struct {
	MaxNewTokens int
	MinNewTokens int     // suppress EOS for this many tokens (0 = off)
	Temperature  float32 // <=0 → 1.0
	TopK         int     // <=0 → full vocab
	TopP         float32 // in (0,1) → nucleus filtering; else off
	// RepetitionPenalty > 1 divides the logit of recently generated
	// tokens (multiplies when negative), CTRL-style. 1.1–1.3 is the
	// useful range; <=1 disables.
	RepetitionPenalty float32
	// RepetitionWindow is how many recent tokens the penalty covers.
	// 0 → 64. The window includes prompt tokens, which is deliberate:
	// echoing the question back is the failure mode the penalty exists
	// to stop.
	RepetitionWindow int
}

func (c SampleConfig) normalise(vocabSize int) SampleConfig {
	if c.Temperature <= 0 {
		c.Temperature = 1.0
	}
	if c.TopK <= 0 || c.TopK > vocabSize {
		c.TopK = vocabSize
	}
	if c.RepetitionWindow <= 0 {
		c.RepetitionWindow = 64
	}
	return c
}

// applyRepetitionPenalty damps the logits of the last window tokens of
// seq. Positive logits are divided by penalty, negative multiplied —
// both push the token away from being re-picked (CTRL, Keskar et al.).
// Each distinct token is penalised ONCE regardless of how many times it
// appears in the window (matching the reference implementations —
// per-occurrence compounding turns a mild 1.2 into a brutal 1.2^n for
// common words like "the" and wrecks fluency).
func applyRepetitionPenalty(logits []float32, seq []int, window int, penalty float32) {
	if penalty <= 1 || len(seq) == 0 {
		return
	}
	start := len(seq) - window
	if start < 0 {
		start = 0
	}
	seen := make(map[int]struct{}, window)
	for _, id := range seq[start:] {
		if id < 0 || id >= len(logits) {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		l := logits[id]
		if math.IsInf(float64(l), 0) || math.IsNaN(float64(l)) {
			continue
		}
		if l > 0 {
			logits[id] = l / penalty
		} else {
			logits[id] = l * penalty
		}
	}
}

// sampleTopKTopP samples from the top-k candidates, optionally reduced
// further to the smallest set whose probability mass reaches topP.
// With topP disabled the candidate set and probabilities are identical
// to topKSample's, though the two are separate code paths on purpose
// (see file header).
func (m *MiniTransformer) sampleTopKTopP(logits []float32, topK int, topP float32) int {
	type cand struct {
		idx int
		val float32
	}
	// Partial selection of the top-k logits (insertion into a small
	// sorted slice — k is 40-ish, V is 50k; O(V·k) worst case but the
	// bubble almost never runs past a few slots).
	cands := make([]cand, 0, topK)
	for i, v := range logits {
		if math.IsInf(float64(v), -1) {
			continue
		}
		if len(cands) < topK {
			cands = append(cands, cand{i, v})
			for j := len(cands) - 1; j > 0 && cands[j].val > cands[j-1].val; j-- {
				cands[j], cands[j-1] = cands[j-1], cands[j]
			}
		} else if v > cands[topK-1].val {
			cands[topK-1] = cand{i, v}
			for j := topK - 1; j > 0 && cands[j].val > cands[j-1].val; j-- {
				cands[j], cands[j-1] = cands[j-1], cands[j]
			}
		}
	}
	if len(cands) == 0 {
		return 0
	}

	// Softmax over the candidates (they are sorted descending).
	maxVal := cands[0].val
	probs := make([]float32, len(cands))
	sum := float32(0)
	for i, c := range cands {
		p := float32(math.Exp(float64(c.val - maxVal)))
		probs[i] = p
		sum += p
	}
	for i := range probs {
		probs[i] /= sum
	}

	// Nucleus cut: keep the smallest prefix with cumulative mass ≥ topP.
	n := len(cands)
	if topP > 0 && topP < 1 {
		cum := float32(0)
		for i, p := range probs {
			cum += p
			if cum >= topP {
				n = i + 1
				break
			}
		}
		// Renormalise over the nucleus.
		sum = 0
		for _, p := range probs[:n] {
			sum += p
		}
		for i := 0; i < n; i++ {
			probs[i] /= sum
		}
	}

	r := m.Rng.Float32()
	cum := float32(0)
	for i := 0; i < n; i++ {
		cum += probs[i]
		if r < cum {
			return cands[i].idx
		}
	}
	return cands[0].idx
}

// GenerateSampled is the full-featured generation entry point: KV-cached
// decoding with temperature, top-k, top-p, repetition penalty, minimum
// length, and an optional cognitive-bridge logit bias.
//
// Per-step order (each stage justified in GenerateFastBiased's header):
// repetition penalty → temperature → EOS suppression → bias → top-k →
// top-p → sample. The penalty runs FIRST, on raw logits, so its
// strength is independent of temperature.
func (m *MiniTransformer) GenerateSampled(prompt []int, cfg SampleConfig, bias []float32) []int {
	if len(prompt) == 0 {
		return prompt
	}
	cfg = cfg.normalise(m.Config.VocabSize)

	maxPrompt := m.Config.MaxSeqLen - 1
	if maxPrompt < 1 {
		maxPrompt = 1
	}
	if len(prompt) > maxPrompt {
		prompt = prompt[len(prompt)-maxPrompt:]
	}

	cache, lastHidden := m.prefill(prompt)
	if lastHidden == nil {
		return prompt
	}

	generated := make([]int, len(prompt), len(prompt)+cfg.MaxNewTokens)
	copy(generated, prompt)
	eosID := m.Config.EOSTokenID

	for i := 0; i < cfg.MaxNewTokens; i++ {
		logits := m.logitsFromHidden(lastHidden)
		if len(logits) == 0 {
			break
		}

		applyRepetitionPenalty(logits, generated, cfg.RepetitionWindow, cfg.RepetitionPenalty)

		for j := range logits {
			logits[j] /= cfg.Temperature
		}

		if i < cfg.MinNewTokens && eosID >= 0 && eosID < len(logits) {
			logits[eosID] = float32(math.Inf(-1))
		}

		ApplyBias(logits, bias)

		next := m.sampleTopKTopP(logits, cfg.TopK, cfg.TopP)
		generated = append(generated, next)

		if next == eosID {
			break
		}
		if cache.SeqLen >= m.Config.MaxSeqLen {
			break
		}

		x := m.singleTokenEmbedding(next, cache.SeqLen)
		for j, block := range m.Blocks {
			x = block.ForwardCachedStep(x, cache.Layers[j])
		}
		x = x.LayerNorm(m.LNFGamma, m.LNFBeta)
		lastHidden = x
		cache.SeqLen++
	}

	return generated
}
