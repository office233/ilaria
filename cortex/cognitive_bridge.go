package cortex

import (
	"math"
)

// ─────────────────────────────────────────────────────────────────────
// COGNITIVE BRIDGE — SDR memory → transformer logits
// ─────────────────────────────────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES
//
// Nexus has two generation engines that never touched each other:
//
//   1. The cognitive path (Encoder → SDR → Hippocampus → Brain.Generate)
//      learns a fact from ONE exposure and survives a restart, but
//      generates via bigram Markov chains — no gradient learning.
//
//   2. The transformer path (MiniTransformer) learns real distributions
//      but is only 5.4M parameters, so it never memorises specific facts.
//
// Everything the hippocampus knows was invisible at generation time.
// This bridge closes that gap: episodic memory is projected onto the
// vocabulary as a LOGIT BIAS applied just before sampling.
//
// WHY A BIAS AND NOT A HARD OVERRIDE
//
// A hard override would make the system a lookup table and destroy the
// transformer's grammar. A bounded additive bias lets memory *tilt* the
// distribution: the transformer still decides how to phrase things, but
// a recalled fact becomes reachable even if the weights never learned it.
//
// The bias is deliberately bounded (see MaxBias). Recall strength scales
// it, so a weak/uncertain memory nudges gently while a strong one pushes
// hard. This keeps the failure mode graceful: a wrong recall degrades
// fluency slightly instead of emitting garbage.

// CognitiveBridge projects recalled episodic memories into a bias vector
// over the transformer vocabulary.
//
// It is intentionally decoupled from Organism so it can be unit-tested
// in isolation and reused by any generation path.
type CognitiveBridge struct {
	// Hippo is the episodic store queried for relevant memories.
	Hippo *Hippocampus

	// Semantic is the optional second bias source: generalized concepts
	// produced by sleep consolidation. Episodic recall carries specific
	// facts; a semantic hit contributes the concept's context words at
	// SemanticWeight strength. Nil disables the semantic contribution
	// (the bridge works exactly as before).
	Semantic *SemanticMemory

	// SemanticWeight scales the semantic contribution relative to the
	// episodic boost. Below 1 because a generalized concept is fuzzier
	// evidence than a verbatim episode.
	SemanticWeight float32

	// Encoder converts prompt text into the SDR query space.
	Encoder *Encoder

	// Tokenizer maps recalled memory text back to token IDs.
	Tokenizer *BPETokenizer

	// VocabSize must match the transformer's output dimension.
	VocabSize int

	// MaxBias caps the logit boost applied to any single token.
	//
	// Calibration note: an untrained/small transformer produces logits
	// spanning roughly [-3.5, +3.0] (spread ~6). A bias must be a
	// meaningful fraction of that spread to change the argmax at all —
	// a bias of 3.0 against a spread of 6 moves a mid-ranked token to
	// the top, which is the intended strength.
	MaxBias float32

	// MinConfidence floors the recall-strength scaling.
	//
	// WHY THIS EXISTS: Hippocampus.Store creates a memory with a low
	// initial Strength (it grows through reconsolidation). Scaling bias
	// by strength/255 alone would make a freshly learned fact contribute
	// a bias near 0.04 — mathematically invisible next to the logit
	// spread, which would defeat the entire point of ONE-SHOT learning.
	//
	// A single exposure is supposed to be usable immediately; repetition
	// should make it *more* dominant, not make the first exposure useless.
	// So confidence = max(strength/255, MinConfidence).
	MinConfidence float32

	// RecallThreshold is the minimum keyword-overlap score required
	// before a memory is considered relevant. Lower = more recall,
	// more false positives.
	RecallThreshold int

	// Enabled allows callers to switch the bridge off at runtime without
	// tearing down wiring (useful for A/B evaluation).
	Enabled bool
}

// NewCognitiveBridge wires a bridge with defaults that are safe for the
// 5.4M-parameter transformer: a moderate bias ceiling and a keyword
// threshold that favours precision over recall.
func NewCognitiveBridge(h *Hippocampus, enc *Encoder, tok *BPETokenizer, vocabSize int) *CognitiveBridge {
	return &CognitiveBridge{
		Hippo:           h,
		Encoder:         enc,
		Tokenizer:       tok,
		VocabSize:       vocabSize,
		MaxBias:         3.0,
		MinConfidence:   0.6,
		RecallThreshold: 2,
		SemanticWeight:  0.5,
		Enabled:         true,
	}
}

// BiasResult reports what the bridge did for one generation step.
// Callers use it for logging and evaluation; it makes the bridge's
// behaviour observable instead of a silent side effect.
type BiasResult struct {
	// Applied is true when a memory was recalled and a bias produced.
	Applied bool

	// Context is the recalled memory's context string (the stored fact).
	Context string

	// Score is the raw keyword-overlap score of the recall.
	Score uint8

	// TokensBiased counts distinct vocabulary entries that were boosted.
	TokensBiased int

	// SemanticApplied is true when a generalized concept contributed to
	// the bias (possibly in addition to an episodic memory).
	SemanticApplied bool
}

// ready reports whether the bridge has every dependency it needs.
// Any missing piece disables biasing rather than panicking, so a
// partially-constructed Organism degrades to plain transformer output.
func (cb *CognitiveBridge) ready() bool {
	return cb != nil &&
		cb.Enabled &&
		cb.Hippo != nil &&
		cb.Encoder != nil &&
		cb.Tokenizer != nil &&
		cb.VocabSize > 0
}

// Keyword extraction reuses the hippocampus's own extractKeywords
// (hippocampus.go): it stems, lowercases and strips stop words, which is
// exactly the vocabulary RecallByKeywords indexes against. Using a
// different tokenisation here would silently break recall.

// ComputeBias returns a per-token additive bias derived from episodic
// memory relevant to the prompt, or nil when nothing is recalled.
//
// The returned slice always has length VocabSize when non-nil, so callers
// can add it to logits without a bounds check.
func (cb *CognitiveBridge) ComputeBias(prompt string) ([]float32, BiasResult) {
	var res BiasResult

	if !cb.ready() {
		return nil, res
	}

	keywords := extractKeywords(prompt)
	if len(keywords) == 0 {
		return nil, res
	}

	// Encode the prompt into SDR space so recall can combine keyword
	// matching with sparse-pattern overlap.
	querySDR := cb.Encoder.EncodeSentence(prompt)

	mem, score, found := cb.Hippo.RecallByKeywords(keywords, cb.RecallThreshold, querySDR)
	if !found && cb.RecallThreshold > 1 {
		// Fallback to single-keyword overlap. A question about a
		// uniquely named subject ("what kind of ball is used in
		// drumball") can share exactly ONE stem with its memory when
		// the other words inflect differently — and that one rare stem
		// is precisely the discriminating signal. Max-hits + SDR
		// tie-breaking still picks the best memory; a weak wrong recall
		// only costs a bounded, gentle bias.
		mem, score, found = cb.Hippo.RecallByKeywords(keywords, 1, querySDR)
	}

	var bias []float32
	seen := make(map[int]struct{})

	// applyTokens raises the bias of ctx's distinct tokens to at least
	// `boost`. Max, not sum: overlapping sources must not compound past
	// MaxBias — the bound is the safety property of the whole bridge.
	applyTokens := func(ctx string, boost float32) int {
		ids := cb.Tokenizer.Encode(ctx)
		if len(ids) == 0 {
			return 0
		}
		if bias == nil {
			bias = make([]float32, cb.VocabSize)
		}
		n := 0
		for _, tid := range ids {
			if tid < 0 || tid >= cb.VocabSize {
				continue
			}
			if _, dup := seen[tid]; !dup {
				seen[tid] = struct{}{}
				n++
			}
			if bias[tid] < boost {
				bias[tid] = boost
			}
		}
		return n
	}

	// ── Source 1: episodic memory (specific facts, full strength) ─────
	if found && mem.Context != "" {
		confidence := float32(mem.Strength) / 255.0
		if confidence < cb.MinConfidence {
			confidence = cb.MinConfidence
		}
		if confidence > 0 {
			applyTokens(mem.Context, cb.MaxBias*confidence)
			res.Applied = true
			res.Context = mem.Context
			res.Score = score
		}
	}

	// ── Source 2: semantic memory (generalized concepts, damped) ──────
	// Consulted even after an episodic hit: the concept's contexts add
	// related vocabulary the single episode may lack. SemanticWeight < 1
	// keeps the fuzzier evidence subordinate.
	if cb.Semantic != nil && cb.SemanticWeight > 0 {
		if concept, _, ok := cb.Semantic.QueryByKeywords(keywords, 2); ok {
			boost := cb.MaxBias * cb.SemanticWeight
			for _, ctx := range concept.Contexts {
				applyTokens(ctx, boost)
			}
			res.SemanticApplied = true
		}
	}

	if len(seen) == 0 {
		return nil, res
	}
	res.TokensBiased = len(seen)

	return bias, res
}

// ApplyBias adds the bias vector to logits in place.
//
// It is separate from ComputeBias so a bias can be computed once for a
// prompt and reused across every decoding step, which is what the
// generation loop actually wants — recomputing recall per token would
// be both slow and unstable.
//
// Non-finite logits (notably the -Inf used for EOS suppression) are left
// untouched: adding to -Inf would either keep it -Inf or, worse, produce
// NaN, which would poison sampling.
func ApplyBias(logits []float32, bias []float32) {
	if len(bias) == 0 || len(logits) == 0 {
		return
	}
	n := len(logits)
	if len(bias) < n {
		n = len(bias)
	}
	for i := 0; i < n; i++ {
		if bias[i] == 0 {
			continue
		}
		if math.IsInf(float64(logits[i]), -1) || math.IsNaN(float64(logits[i])) {
			continue
		}
		logits[i] += bias[i]
	}
}
