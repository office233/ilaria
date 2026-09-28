package cortex

// sdr_attention.go — SDR-Based Attention Mechanism
//
// Replaces Softmax attention with popcount-based SDR similarity.
// This is the core innovation that makes Ilaria fundamentally
// different from Transformers.
//
// Transformer Attention:
//   Attention(Q,K,V) = Softmax(Q·K^T / √d) · V
//   Complexity: O(N² · d) — QUADRATIC, floating point
//
// SDR Attention:
//   Score(Q,K) = popcount(Q AND K)
//   Top-K selection (no Softmax!)
//   Output = Union of top-K value SDRs
//   Complexity: O(N · d/64) — LINEAR, integer only
//
// Why this works (mathematically):
//   Hochreiter proved that Transformer attention IS equivalent to
//   the update rule of a Modern Hopfield Network (associative memory).
//   SDR overlap IS a form of associative memory retrieval.
//   Therefore, SDR attention is a valid, efficient alternative.

import (
	"math/bits"
)

// Attention mechanism constants.
//
// These constants are architectural invariants of the SDR attention mechanism.
// They are NOT user-configurable — changing them requires understanding the
// mathematical properties of the attention scoring.
const (
	// sdrAttentionDefaultSparsity is the default number of active bits
	// when a query SDR has ActiveCount == 0.
	sdrAttentionDefaultSparsity = 50

	// sdrAttentionMinWeight is the minimum weight for an attention
	// value to contribute to the output. Scores below this are too
	// weak and are skipped.
	sdrAttentionMinWeight uint8 = 32

	// sdrActivationValue is the int16 activation level assigned to
	// active bits when converting an SDR to a dense activation vector.
	sdrActivationValue int16 = 127
)

// SDRAttentionHead represents a single attention head using SDR operations.
// It stores a set of key-value pairs and retrieves the best-matching
// values for a given query using popcount similarity.
type SDRAttentionHead struct {
	KeySize   int // Size of key SDRs in bits
	ValueSize int // Size of value SDRs in bits
	MaxSlots  int // Maximum number of key-value pairs (ring buffer capacity)

	// Storage: parallel arrays for cache-friendly access
	Keys   []SDR // [MaxSlots] key SDRs (ring buffer of past keys)
	Values []SDR // [MaxSlots] value SDRs (ring buffer of past values)
	Count  int   // Total number of stored pairs (monotonically increasing)
}

// NewSDRAttentionHead creates a new attention head.
func NewSDRAttentionHead(keySize, valueSize, maxSlots int) *SDRAttentionHead {
	if maxSlots <= 0 {
		maxSlots = 1 // Prevent division by zero in Store()
	}
	return &SDRAttentionHead{
		KeySize:   keySize,
		ValueSize: valueSize,
		MaxSlots:  maxSlots,
		Keys:      make([]SDR, maxSlots),
		Values:    make([]SDR, maxSlots),
		Count:     0,
	}
}

// Store adds a key-value pair to the attention memory.
// If full, overwrites the oldest entry (ring buffer).
func (h *SDRAttentionHead) Store(key, value SDR) {
	idx := h.Count % h.MaxSlots
	h.Keys[idx] = key
	h.Values[idx] = value
	h.Count++
}

// scoredKey is the (key-index, overlap-score) pair used during top-K
// selection in Query / QueryWithScratch. Lifted to package level so
// QueryScratch can reuse its backing array across calls.
type scoredKey struct {
	idx   int
	score int
}

// QueryScratch holds reusable buffers for SDRAttentionHead.QueryWithScratch.
//
// A QueryScratch is owned by a single caller (e.g. one CortexBlock) and is
// NOT safe for concurrent use. The plain Query() method retains the previous
// allocate-per-call behaviour and is still safe to call concurrently on
// the same Head with the same SDR inputs.
//
// Typical usage:
//
//	var s QueryScratch
//	for token := range tokens {
//	    attended := head.QueryWithScratch(query, topK, &s)
//	    ...
//	}
type QueryScratch struct {
	topItems  []scoredKey
	bitCounts []uint8
}

// ensure resizes the scratch buffers for a Query on a head with the given
// ValueSize and topK. Existing capacity is reused when sufficient.
func (s *QueryScratch) ensure(valueSize, topK int) {
	if cap(s.topItems) < topK {
		s.topItems = make([]scoredKey, 0, topK)
	} else {
		s.topItems = s.topItems[:0]
	}
	if cap(s.bitCounts) < valueSize {
		s.bitCounts = make([]uint8, valueSize)
	} else {
		s.bitCounts = s.bitCounts[:valueSize]
		// Zero the slice for the new call.
		for i := range s.bitCounts {
			s.bitCounts[i] = 0
		}
	}
}

// Query performs attention: finds the top-K most similar keys to the query
// and returns a blended value SDR.
//
// This is the equivalent of Softmax attention but using integer popcount:
//  1. For each key: score = popcount(query AND key)
//  2. Select top-K highest scores
//  3. Return union of corresponding values (weighted by overlap)
//
// Allocates internal scratch on every call. For repeated calls in a hot
// loop, use QueryWithScratch with a caller-owned QueryScratch instead.
func (h *SDRAttentionHead) Query(query SDR, topK int) SDR {
	var s QueryScratch
	return h.QueryWithScratch(query, topK, &s)
}

// QueryWithScratch is the allocation-free variant of Query.
// The caller provides a QueryScratch that holds the top-K buffer and the
// bit-count accumulator; both are reused across calls.
//
// The returned SDR is still freshly allocated (its Bits slice is needed
// downstream and cannot be aliased with scratch state). All other
// intermediate allocations are eliminated.
func (h *SDRAttentionHead) QueryWithScratch(query SDR, topK int, scratch *QueryScratch) SDR {
	n := h.Count
	if n > h.MaxSlots {
		n = h.MaxSlots
	}
	if n == 0 {
		return NewSDR(h.ValueSize)
	}
	if topK > n {
		topK = n
	}
	if topK <= 0 {
		topK = 1
	}

	scratch.ensure(h.ValueSize, topK)
	topItems := scratch.topItems

	// Phase 1: Compute overlap scores using popcount.
	for i := 0; i < n; i++ {
		keyIdx := i % h.MaxSlots
		score := overlapCount(query, h.Keys[keyIdx])

		if len(topItems) < topK {
			inserted := false
			for j := 0; j < len(topItems); j++ {
				if score > topItems[j].score {
					topItems = append(topItems, scoredKey{})
					copy(topItems[j+1:], topItems[j:])
					topItems[j] = scoredKey{idx: keyIdx, score: score}
					inserted = true
					break
				}
			}
			if !inserted {
				topItems = append(topItems, scoredKey{idx: keyIdx, score: score})
			}
		} else if score > topItems[topK-1].score {
			for j := 0; j < topK; j++ {
				if score > topItems[j].score {
					copy(topItems[j+1:], topItems[j:])
					topItems[j] = scoredKey{idx: keyIdx, score: score}
					break
				}
			}
		}
	}

	if len(topItems) == 0 {
		return NewSDR(h.ValueSize)
	}

	// Phase 2: blend values from top-K matches.
	// Single best match: clone its value directly.
	if len(topItems) == 1 || topItems[0].score == 0 {
		if topItems[0].score > 0 {
			return h.Values[topItems[0].idx].Clone()
		}
		return NewSDR(h.ValueSize)
	}

	bitCounts := scratch.bitCounts
	maxScore := topItems[0].score
	if maxScore == 0 {
		maxScore = 1
	}

	for _, item := range topItems {
		if item.score == 0 {
			continue
		}
		v := h.Values[item.idx]
		weight := uint8((item.score * 255) / maxScore)
		if weight < sdrAttentionMinWeight {
			continue
		}

		for _, bit := range v.ActiveIndices() {
			if bit < len(bitCounts) {
				newVal := uint16(bitCounts[bit]) + uint16(weight)
				if newVal > 255 {
					newVal = 255
				}
				bitCounts[bit] = uint8(newVal)
			}
		}
	}

	targetActive := query.ActiveCount
	if targetActive == 0 {
		targetActive = sdrAttentionDefaultSparsity
	}
	return selectTopBits(bitCounts, h.ValueSize, targetActive)
}

// selectTopBits creates an SDR by selecting the N bits with highest counts.
// Complexity: O(maxCount × size) where maxCount is the highest value in counts
// (capped at 255 for uint8) and size is the SDR size. For typical values
// (maxCount ≤ 255, size = SDR dimension) this is fast and avoids a full sort.
func selectTopBits(counts []uint8, size, n int) SDR {
	if n > size {
		n = size
	}

	// Find the threshold: the N-th highest count
	// Use a simple approach: iterate from highest count down
	result := NewSDR(size)
	selected := 0

	// Find max count
	var maxCount uint8
	for _, c := range counts {
		if c > maxCount {
			maxCount = c
		}
	}

	// Select bits from highest count downward
	for threshold := maxCount; threshold > 0 && selected < n; threshold-- {
		for bit, c := range counts {
			if c == threshold && selected < n {
				result.Set(bit)
				selected++
			}
		}
	}

	return result
}

// overlapCount computes popcount(a AND b) — the number of shared active bits.
// This is the core similarity metric, equivalent to dot product in attention.
func overlapCount(a, b SDR) int {
	count := 0
	// Process uint64 words for maximum popcount throughput
	aWords := len(a.Bits)
	bWords := len(b.Bits)
	minWords := aWords
	if bWords < minWords {
		minWords = bWords
	}

	for i := 0; i < minWords; i++ {
		count += bits.OnesCount64(a.Bits[i] & b.Bits[i])
	}
	return count
}

// ---------------------------------------------------------------------------
// Multi-Head SDR Attention
// ---------------------------------------------------------------------------

// MultiHeadSDRAttention implements multi-head attention using SDR operations.
// Each head attends to different "aspects" of the input — analogous to
// multi-head attention in Transformers but using binary similarity.
type MultiHeadSDRAttention struct {
	Heads    []*SDRAttentionHead
	NumHeads int
	// Projection layers: project input into different subspaces per head
	QueryProjections []*TernaryLayer // One per head
	KeyProjections   []*TernaryLayer // One per head
	OutputProjection *TernaryLayer   // Combines head outputs
}

// NewMultiHeadSDRAttention creates multi-head SDR attention.
// inputSize: dimension of input SDR
// headSize: dimension of each head's key/value SDR
// numHeads: number of attention heads
// maxSlots: maximum context length (how many past tokens to attend to)
func NewMultiHeadSDRAttention(inputSize, headSize, numHeads, maxSlots int) *MultiHeadSDRAttention {
	heads := make([]*SDRAttentionHead, numHeads)
	qProj := make([]*TernaryLayer, numHeads)
	kProj := make([]*TernaryLayer, numHeads)

	for i := 0; i < numHeads; i++ {
		heads[i] = NewSDRAttentionHead(headSize, headSize, maxSlots)
		qProj[i] = NewTernaryLayer(inputSize, headSize)
		kProj[i] = NewTernaryLayer(inputSize, headSize)
	}

	// Output projection combines all heads
	outProj := NewTernaryLayer(headSize*numHeads, inputSize)

	return &MultiHeadSDRAttention{
		Heads:            heads,
		NumHeads:         numHeads,
		QueryProjections: qProj,
		KeyProjections:   kProj,
		OutputProjection: outProj,
	}
}

// ProcessToken processes one token through multi-head attention.
// It stores the token as a key-value pair and returns the attended output.
func (m *MultiHeadSDRAttention) ProcessToken(input SDR, topK int) SDR {
	headOutputs := make([]int16, 0, m.NumHeads*m.Heads[0].KeySize)

	for h := 0; h < m.NumHeads; h++ {
		// Project input into this head's query/key space using ternary layers
		// Convert SDR to int16 activations for ternary forward
		inputActivations := sdrToActivations(input)

		queryAct := m.QueryProjections[h].Forward(inputActivations)
		keyAct := m.KeyProjections[h].Forward(inputActivations)

		// Convert activations back to SDRs
		sparsity := input.ActiveCount
		if sparsity <= 0 {
			sparsity = sdrAttentionDefaultSparsity // Default SDR sparsity fallback
		}
		querySDR := activationsToSDR(queryAct, sparsity)
		keySDR := activationsToSDR(keyAct, sparsity)

		// Store this token's key and value (value = input SDR in this head's space)
		m.Heads[h].Store(keySDR, querySDR)

		// Query: find similar past tokens
		attended := m.Heads[h].Query(querySDR, topK)

		// Collect head output as activations
		headAct := sdrToActivations(attended)
		headOutputs = append(headOutputs, headAct...)
	}

	// Combine heads through output projection
	combined := m.OutputProjection.Forward(headOutputs)
	return activationsToSDR(combined, input.ActiveCount)
}

// sdrToActivations converts an SDR to int16 activations.
// Active bits become 127, inactive become 0.
func sdrToActivations(sdr SDR) []int16 {
	out := make([]int16, sdr.Size)
	for _, bit := range sdr.ActiveIndices() {
		if bit < sdr.Size {
			out[bit] = sdrActivationValue
		}
	}
	return out
}

// activationsToSDR converts int16 activations to an SDR by selecting top-N.
func activationsToSDR(activations []int16, topN int) SDR {
	size := len(activations)
	sdr := NewSDR(size)

	if topN <= 0 {
		return sdr
	}

	if topN > size {
		topN = size
	}

	// Find top-N activations
	type indexedVal struct {
		idx int
		val int16
	}

	// Simple insertion sort for top-N (efficient for small N)
	top := make([]indexedVal, 0, topN)
	for i, v := range activations {
		if v <= 0 {
			continue
		}
		if len(top) < topN {
			inserted := false
			for j := 0; j < len(top); j++ {
				if v > top[j].val {
					top = append(top, indexedVal{})
					copy(top[j+1:], top[j:])
					top[j] = indexedVal{idx: i, val: v}
					inserted = true
					break
				}
			}
			if !inserted {
				top = append(top, indexedVal{idx: i, val: v})
			}
		} else if v > top[topN-1].val {
			for j := 0; j < topN; j++ {
				if v > top[j].val {
					copy(top[j+1:], top[j:])
					top[j] = indexedVal{idx: i, val: v}
					break
				}
			}
		}
	}

	for _, item := range top {
		sdr.Set(item.idx)
	}

	return sdr
}
