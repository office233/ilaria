package cortex

import (
	"math/rand"
	"testing"
)

// These tests prove the load-bearing claim of the cognitive bridge:
// a fact held only in episodic memory can change what the transformer
// emits, WITHOUT retraining a single weight.

func newTinyTransformer(t *testing.T, vocabSize int) *MiniTransformer {
	t.Helper()
	cfg := TransformerConfig{
		VocabSize:  vocabSize,
		EmbedDim:   32,
		NumHeads:   2,
		NumLayers:  2,
		FFNDim:     64,
		MaxSeqLen:  32,
		EOSTokenID: 1,
	}
	return NewMiniTransformer(cfg, rand.New(rand.NewSource(7)))
}

func TestGenerateFastBiased_NilBiasMatchesUnbiased(t *testing.T) {
	// With no bias the biased path must be behaviourally identical to
	// GenerateFastMin, otherwise enabling the bridge would perturb
	// baseline behaviour even when memory has nothing to say.
	vocab := 64
	prompt := []int{5, 9, 12}

	a := newTinyTransformer(t, vocab)
	a.Rng = rand.New(rand.NewSource(1234))
	want := a.GenerateFastMin(prompt, 8, 0, 1.0, 10)

	b := newTinyTransformer(t, vocab)
	b.Rng = rand.New(rand.NewSource(1234))
	got := b.GenerateFastBiased(prompt, 8, 0, 1.0, 10, nil)

	if len(got) != len(want) {
		t.Fatalf("length differs: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("token %d differs: got %d want %d (nil bias must be a no-op)", i, got[i], want[i])
		}
	}
}

func TestGenerateFastBiased_StrongBiasForcesTargetToken(t *testing.T) {
	// The decisive test. A large bias on one token must make the model
	// emit it, even though the untrained weights have no reason to.
	// This is exactly the mechanism that lets a one-shot memorised fact
	// surface from a 5.4M-parameter model that never learned it.
	vocab := 64
	target := 42
	prompt := []int{5, 9, 12}

	m := newTinyTransformer(t, vocab)
	m.Rng = rand.New(rand.NewSource(99))

	bias := make([]float32, vocab)
	bias[target] = 50.0 // far above any logit the tiny model produces

	out := m.GenerateFastBiased(prompt, 6, 6, 1.0, 5, bias)

	generated := out[len(prompt):]
	if len(generated) == 0 {
		t.Fatal("no tokens generated")
	}

	hits := 0
	for _, tok := range generated {
		if tok == target {
			hits++
		}
	}
	if hits == 0 {
		t.Fatalf("strongly biased token %d never emitted; generated %v", target, generated)
	}
}

func TestGenerateFastBiased_RespectsEOSSuppression(t *testing.T) {
	// A bias on EOS must not defeat the suppression window; ApplyBias
	// skips -Inf, so EOS should stay suppressed for minNewTokens.
	vocab := 64
	eos := 1
	prompt := []int{5, 9}

	m := newTinyTransformer(t, vocab)
	m.Rng = rand.New(rand.NewSource(3))

	bias := make([]float32, vocab)
	bias[eos] = 100.0 // try hard to force an early stop

	minNew := 5
	out := m.GenerateFastBiased(prompt, 10, minNew, 1.0, 5, bias)
	generated := out[len(prompt):]

	for i := 0; i < minNew && i < len(generated); i++ {
		if generated[i] == eos {
			t.Fatalf("EOS emitted at position %d despite suppression window of %d", i, minNew)
		}
	}
}

func TestGenerateFastBiased_EmptyPromptIsSafe(t *testing.T) {
	m := newTinyTransformer(t, 32)
	bias := make([]float32, 32)
	bias[3] = 5.0

	if out := m.GenerateFastBiased(nil, 4, 0, 1.0, 5, bias); len(out) != 0 {
		t.Fatalf("empty prompt should return empty, got %v", out)
	}
}
