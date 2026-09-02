package cortex

import (
	"math/rand"
	"testing"
)

// These tests guard the 2026-09 repair of online self-training.
//
// BACKGROUND: until that repair, Organism self-training (SelfEvolve,
// TrainTransformerFromQA/Memories/Corpus) went through the legacy
// MiniTransformer.TrainStep, which updated embeddings only and added
// Gaussian NOISE to every attention/FFN weight. Calling it on a trained
// checkpoint actively corrupted the model, and repeated calls could not
// converge. Self-training now runs real backprop through Adam moments
// held on the Organism. If someone reintroduces the noise path, the
// convergence assertions below are designed to catch it.

// testQAOrganism builds the minimal organism needed by the self-training
// entry points: transformer + tokenizer + config. No brain regions.
func testQAOrganism(t *testing.T) (*Organism, *BPETokenizer) {
	t.Helper()

	tok := NewBPETokenizer(300)
	tok.Train([]string{
		"the capital of france is paris",
		"the capital of japan is tokyo",
		"water boils at one hundred degrees",
	})

	tcfg := TransformerConfig{
		VocabSize:  tok.VocabSize,
		EmbedDim:   32,
		NumHeads:   2,
		NumLayers:  2,
		FFNDim:     64,
		MaxSeqLen:  64,
		EOSTokenID: 3,
	}
	o := &Organism{
		Config:      DefaultConfig(),
		Transformer: NewMiniTransformer(tcfg, rand.New(rand.NewSource(7))),
		Tokenizer:   tok,
	}
	return o, tok
}

// TestSelfTrainingQA_Converges: repeated self-training on one QA pair must
// drive the loss down hard. The legacy noise path plateaued (embeddings
// chased a target that block noise kept moving), so a strong decrease is
// the signature of real backprop.
func TestSelfTrainingQA_Converges(t *testing.T) {
	o, _ := testQAOrganism(t)

	question := "what is the capital of france"
	answer := "paris"

	first := o.TrainTransformerFromQA(question, answer, 0.01)
	if first != first || first <= 0 {
		t.Fatalf("first loss invalid: %v", first)
	}

	var last float32
	for i := 0; i < 60; i++ {
		last = o.TrainTransformerFromQA(question, answer, 0.01)
	}

	if last != last {
		t.Fatal("loss became NaN during self-training")
	}
	if last > first*0.5 {
		t.Fatalf("self-training barely learns: loss %.4f → %.4f (needs < 50%% of start; noise-update regression?)",
			first, last)
	}
	t.Logf("QA self-training loss: %.4f → %.4f over 60 steps", first, last)
}

// TestEnsureAdamState_Lifecycle: moments must persist across calls (that
// is the whole point of holding them on the Organism) and must be rebuilt
// when the transformer instance is swapped, since buffer shapes are tied
// to a specific model.
func TestEnsureAdamState_Lifecycle(t *testing.T) {
	o, tok := testQAOrganism(t)

	s1 := o.ensureAdamState()
	if s1 == nil {
		t.Fatal("ensureAdamState returned nil with a live transformer")
	}

	o.TrainTransformerFromQA("what is the capital of japan", "tokyo", 0.01)

	s2 := o.ensureAdamState()
	if s1 != s2 {
		t.Fatal("Adam state was rebuilt between calls — moments are being thrown away")
	}
	if s2.Step == 0 {
		t.Fatal("Adam step counter did not advance — self-training is not going through Adam")
	}

	// Swap the transformer: stale moments must not survive the swap.
	tcfg := o.Transformer.Config
	tcfg.EmbedDim = 16
	tcfg.FFNDim = 32
	o.Transformer = NewMiniTransformer(tcfg, rand.New(rand.NewSource(9)))

	s3 := o.ensureAdamState()
	if s3 == s2 {
		t.Fatal("Adam state not rebuilt after transformer swap — shape mismatch corruption waiting to happen")
	}
	_ = tok
}

// TestTrainStep_IsRealBackprop guards the legacy entry point itself:
// TrainStep now delegates to full backprop, so overfitting one sequence
// must succeed. Under the old noise updates this plateaued far above 50%.
func TestTrainStep_IsRealBackprop(t *testing.T) {
	tcfg := TransformerConfig{
		VocabSize: 50, EmbedDim: 16, NumHeads: 2,
		NumLayers: 1, FFNDim: 32, MaxSeqLen: 16,
	}
	m := NewMiniTransformer(tcfg, rand.New(rand.NewSource(42)))
	seq := []int{2, 5, 10, 15, 20, 3}

	first := m.TrainStep(seq, 0.05)
	var last float32
	for i := 0; i < 80; i++ {
		last = m.TrainStep(seq, 0.05)
	}
	if last > first*0.5 {
		t.Fatalf("TrainStep does not converge: %.4f → %.4f — noise-update path reintroduced?", first, last)
	}
	t.Logf("TrainStep loss: %.4f → %.4f over 80 steps", first, last)
}
