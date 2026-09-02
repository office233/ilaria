package cortex

import (
	"math/rand"
	"testing"
	"time"
)

// TestGenerateFastEquivalence verifies that the KV-cached fast path
// produces the same tokens as the un-cached training path for the same
// prompt and the same RNG state. With greedy sampling (low temperature,
// top-k = 1) the two paths must agree deterministically; this is the
// strictest possible correctness check for the cache.
func TestGenerateFastEquivalence(t *testing.T) {
	cfg := TransformerConfig{
		VocabSize:  64,
		EmbedDim:   16,
		NumHeads:   2,
		NumLayers:  2,
		FFNDim:     32,
		MaxSeqLen:  32,
		EOSTokenID: -1,
	}

	rng1 := rand.New(rand.NewSource(7))
	m := NewMiniTransformer(cfg, rng1)

	prompt := []int{1, 5, 9, 13}
	maxNew := 8

	const temp = 0.001
	const k = 1

	m.Rng = rand.New(rand.NewSource(42))
	slow := m.Generate(prompt, maxNew, temp, k)

	m.Rng = rand.New(rand.NewSource(42))
	fast := m.GenerateFast(prompt, maxNew, temp, k)

	if len(slow) != len(fast) {
		t.Fatalf("length mismatch: slow=%d fast=%d", len(slow), len(fast))
	}
	for i := range slow {
		if slow[i] != fast[i] {
			t.Fatalf("token mismatch at %d: slow=%d fast=%d (slow=%v fast=%v)",
				i, slow[i], fast[i], slow, fast)
		}
	}
}

// TestGenerateFastNotSlower exercises a basic timing sanity check: the
// cached path must not regress catastrophically. We do not assert a
// specific speedup because that depends on the host, but a bug that
// makes cached path slower than scratch needs to be caught.
func TestGenerateFastNotSlower(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping perf check in -short mode")
	}

	cfg := TransformerConfig{
		VocabSize:  256,
		EmbedDim:   32,
		NumHeads:   4,
		NumLayers:  2,
		FFNDim:     64,
		MaxSeqLen:  64,
		EOSTokenID: -1,
	}

	rng := rand.New(rand.NewSource(1))
	m := NewMiniTransformer(cfg, rng)

	prompt := make([]int, 20)
	for i := range prompt {
		prompt[i] = i + 1
	}
	maxNew := 16

	m.Rng = rand.New(rand.NewSource(99))
	t0 := time.Now()
	_ = m.Generate(prompt, maxNew, 1.0, 8)
	slow := time.Since(t0)

	m.Rng = rand.New(rand.NewSource(99))
	t0 = time.Now()
	_ = m.GenerateFast(prompt, maxNew, 1.0, 8)
	fast := time.Since(t0)

	t.Logf("Generate (slow)     = %v", slow)
	t.Logf("GenerateFast (cache)= %v", fast)

	if fast > 2*slow+10*time.Millisecond {
		t.Fatalf("GenerateFast unexpectedly slow: %v vs %v", fast, slow)
	}
}

// TestGenerateFastMinEquivalentToGenerateFast verifies that calling
// GenerateFastMin with minNewTokens=0 produces identical output to
// GenerateFast — the no-suppression path must be a pure pass-through.
// This protects against accidental behavioural drift when adding the
// new suppression code.
func TestGenerateFastMinEquivalentToGenerateFast(t *testing.T) {
	cfg := TransformerConfig{
		VocabSize:  64,
		EmbedDim:   16,
		NumHeads:   2,
		NumLayers:  2,
		FFNDim:     32,
		MaxSeqLen:  32,
		EOSTokenID: 7, // arbitrary in-vocab EOS for the test
	}

	rng := rand.New(rand.NewSource(7))
	m := NewMiniTransformer(cfg, rng)

	prompt := []int{1, 5, 9, 13}
	maxNew := 8

	m.Rng = rand.New(rand.NewSource(42))
	noMin := m.GenerateFast(prompt, maxNew, 0.5, 5)

	m.Rng = rand.New(rand.NewSource(42))
	minZero := m.GenerateFastMin(prompt, maxNew, 0, 0.5, 5)

	if len(noMin) != len(minZero) {
		t.Fatalf("length mismatch: GenerateFast=%d GenerateFastMin(0)=%d",
			len(noMin), len(minZero))
	}
	for i := range noMin {
		if noMin[i] != minZero[i] {
			t.Fatalf("token mismatch at %d: GenerateFast=%d GenerateFastMin(0)=%d",
				i, noMin[i], minZero[i])
		}
	}
}

// TestGenerateFastMinSuppressesEOS verifies that with minNewTokens > 0
// the EOS token is never emitted as one of the first minNewTokens
// generated tokens. Strategy: construct a tiny model and force EOS to
// be the most likely token by biasing the embeddings post-construction
// — then assert that with greedy sampling (top-k=1) we still get
// non-EOS tokens for the first minNewTokens positions.
//
// Simpler approach used here: rely on the fact that with a fixed RNG
// seed and top-k=vocab_size, a random model will sometimes produce
// EOS in the first few tokens. We just assert that with min=N, the
// emitted prefix never contains EOS at positions 0..N-1.
func TestGenerateFastMinSuppressesEOS(t *testing.T) {
	const eosID = 7
	cfg := TransformerConfig{
		VocabSize:  16,
		EmbedDim:   8,
		NumHeads:   2,
		NumLayers:  1,
		FFNDim:     16,
		MaxSeqLen:  32,
		EOSTokenID: eosID,
	}

	// Try many seeds; if no seed produces EOS in first 3 tokens with
	// min=0, the test is inconclusive (skip). Otherwise assert that
	// min=3 always avoids EOS in first 3 positions.
	prompt := []int{1, 2, 3}
	const maxNew = 6
	const minSuppress = 3

	foundEOSCase := false
	for seed := int64(0); seed < 50; seed++ {
		rng := rand.New(rand.NewSource(seed))
		m := NewMiniTransformer(cfg, rng)

		m.Rng = rand.New(rand.NewSource(seed * 31))
		noMin := m.GenerateFastMin(prompt, maxNew, 0, 1.0, cfg.VocabSize)
		newTokens := noMin[len(prompt):]
		hasEarlyEOS := false
		for i := 0; i < minSuppress && i < len(newTokens); i++ {
			if newTokens[i] == eosID {
				hasEarlyEOS = true
				break
			}
		}
		if !hasEarlyEOS {
			continue
		}
		foundEOSCase = true

		// Now run with suppression and assert no EOS in first minSuppress.
		m.Rng = rand.New(rand.NewSource(seed * 31))
		withMin := m.GenerateFastMin(prompt, maxNew, minSuppress, 1.0, cfg.VocabSize)
		newWith := withMin[len(prompt):]
		for i := 0; i < minSuppress && i < len(newWith); i++ {
			if newWith[i] == eosID {
				t.Fatalf("seed=%d: EOS emitted at position %d despite min=%d suppression: %v",
					seed, i, minSuppress, newWith)
			}
		}
	}
	if !foundEOSCase {
		t.Skip("could not find a seed where un-suppressed generation emits EOS early; test inconclusive but suppression code path untested")
	}
}

// TestPrefillBatchedEquivalence: the batched prefill (one Forward over
// the prompt) must produce byte-identical KV caches and final hidden
// state to the serial reference (token-by-token cached steps). Any
// drift here silently corrupts every generation.
func TestPrefillBatchedEquivalence(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	cfg := TransformerConfig{
		VocabSize: 120, EmbedDim: 32, NumHeads: 4,
		NumLayers: 3, FFNDim: 64, MaxSeqLen: 40, EOSTokenID: 3,
	}
	m := NewMiniTransformer(cfg, rng)

	prompt := []int{5, 17, 42, 99, 7, 23, 88, 3, 61, 12, 5, 40}

	cacheB, hiddenB := m.prefill(prompt)
	cacheS, hiddenS := m.prefillSerial(prompt)

	if cacheB.SeqLen != cacheS.SeqLen {
		t.Fatalf("SeqLen %d vs %d", cacheB.SeqLen, cacheS.SeqLen)
	}
	const tol = 1e-4
	for l := range cacheB.Layers {
		kb, ks := cacheB.Layers[l].K, cacheS.Layers[l].K
		vb, vs := cacheB.Layers[l].V, cacheS.Layers[l].V
		if kb.Shape[0] != ks.Shape[0] || vb.Shape[0] != vs.Shape[0] {
			t.Fatalf("layer %d: K/V row counts differ", l)
		}
		for i := range ks.Data {
			if d := kb.Data[i] - ks.Data[i]; d > tol || d < -tol {
				t.Fatalf("layer %d K[%d]: batched %v vs serial %v", l, i, kb.Data[i], ks.Data[i])
			}
		}
		for i := range vs.Data {
			if d := vb.Data[i] - vs.Data[i]; d > tol || d < -tol {
				t.Fatalf("layer %d V[%d]: batched %v vs serial %v", l, i, vb.Data[i], vs.Data[i])
			}
		}
	}
	for i := range hiddenS.Data {
		if d := hiddenB.Data[i] - hiddenS.Data[i]; d > tol || d < -tol {
			t.Fatalf("hidden[%d]: batched %v vs serial %v", i, hiddenB.Data[i], hiddenS.Data[i])
		}
	}
}

// TestPrefillAndCacheEquivalence_RoPESwiGLU: the cached generation path
// must match the training-path forward under the modern architecture
// too. RoPE makes this test critical — the cache stores ROTATED keys,
// and any position-offset mistake in the cached step desynchronises
// generation from training silently.
func TestPrefillAndCacheEquivalence_RoPESwiGLU(t *testing.T) {
	rng := rand.New(rand.NewSource(123))
	cfg := TransformerConfig{
		VocabSize: 90, EmbedDim: 24, NumHeads: 3,
		NumLayers: 2, FFNDim: 48, MaxSeqLen: 32, EOSTokenID: 3,
		UseRoPE: true, UseSwiGLU: true,
	}
	m := NewMiniTransformer(cfg, rng)
	prompt := []int{4, 17, 55, 8, 71, 22, 9}

	// Batched prefill vs serial reference under RoPE+SwiGLU.
	cacheB, hiddenB := m.prefill(prompt)
	cacheS, hiddenS := m.prefillSerial(prompt)
	const tol = 1e-4
	for l := range cacheB.Layers {
		for i := range cacheS.Layers[l].K.Data {
			if d := cacheB.Layers[l].K.Data[i] - cacheS.Layers[l].K.Data[i]; d > tol || d < -tol {
				t.Fatalf("RoPE K mismatch at layer %d idx %d", l, i)
			}
		}
		for i := range cacheS.Layers[l].V.Data {
			if d := cacheB.Layers[l].V.Data[i] - cacheS.Layers[l].V.Data[i]; d > tol || d < -tol {
				t.Fatalf("V mismatch at layer %d idx %d", l, i)
			}
		}
	}
	for i := range hiddenS.Data {
		if d := hiddenB.Data[i] - hiddenS.Data[i]; d > tol || d < -tol {
			t.Fatalf("hidden mismatch idx %d", i)
		}
	}

	// Greedy generation: cached fast path vs uncached full re-forward.
	// Identical arch, identical weights — token streams must agree.
	fast := m.GenerateFast(prompt, 8, 0.0001, 1)
	slow := m.Generate(prompt, 8, 0.0001, 1)
	if len(fast) != len(slow) {
		t.Fatalf("length mismatch: fast=%d slow=%d", len(fast), len(slow))
	}
	for i := range fast {
		if fast[i] != slow[i] {
			t.Fatalf("greedy divergence at %d: fast=%d slow=%d (fast=%v slow=%v)",
				i, fast[i], slow[i], fast, slow)
		}
	}
}
