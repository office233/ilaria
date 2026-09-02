package cortex

import (
	"math"
	"math/rand"
	"testing"
)

func samplingTestModel() *MiniTransformer {
	cfg := TransformerConfig{
		VocabSize: 60, EmbedDim: 16, NumHeads: 2,
		NumLayers: 1, FFNDim: 32, MaxSeqLen: 64, EOSTokenID: 3,
	}
	return NewMiniTransformer(cfg, rand.New(rand.NewSource(21)))
}

// TestApplyRepetitionPenalty: recently emitted tokens must be damped in
// the direction that lowers their probability, for both logit signs;
// -Inf entries (EOS suppression) must pass through untouched.
func TestApplyRepetitionPenalty(t *testing.T) {
	logits := []float32{2.0, -2.0, 5.0, float32(math.Inf(-1))}
	applyRepetitionPenalty(logits, []int{0, 1, 3}, 64, 2.0)

	if logits[0] != 1.0 {
		t.Errorf("positive logit: got %v, want 1.0 (divided)", logits[0])
	}
	if logits[1] != -4.0 {
		t.Errorf("negative logit: got %v, want -4.0 (multiplied)", logits[1])
	}
	if logits[2] != 5.0 {
		t.Errorf("unseen token changed: %v", logits[2])
	}
	if !math.IsInf(float64(logits[3]), -1) {
		t.Errorf("-Inf corrupted: %v", logits[3])
	}
}

// TestApplyRepetitionPenalty_Window: tokens beyond the window escape
// the penalty.
func TestApplyRepetitionPenalty_Window(t *testing.T) {
	logits := []float32{4.0, 4.0}
	seq := []int{0, 1, 1, 1} // token 0 is oldest
	applyRepetitionPenalty(logits, seq, 3, 2.0)
	if logits[0] != 4.0 {
		t.Errorf("token outside window penalised: %v", logits[0])
	}
	if logits[1] != 2.0 {
		t.Errorf("token inside window not penalised: %v", logits[1])
	}
}

// TestSampleTopKTopP_NucleusCut: with one dominant candidate and a
// tight topP, sampling must always return the dominant token — the
// nucleus collapses to size 1 regardless of RNG draw.
func TestSampleTopKTopP_NucleusCut(t *testing.T) {
	m := samplingTestModel()
	logits := make([]float32, 60)
	logits[7] = 10.0 // ~e^10 heavier than everything else
	for trial := 0; trial < 20; trial++ {
		if got := m.sampleTopKTopP(logits, 40, 0.5); got != 7 {
			t.Fatalf("nucleus sampling escaped the dominant token: got %d", got)
		}
	}
}

// TestSampleTopKTopP_InfExcluded: -Inf logits (suppressed EOS) must
// never be sampled even with full-vocab top-k.
func TestSampleTopKTopP_InfExcluded(t *testing.T) {
	m := samplingTestModel()
	logits := make([]float32, 60)
	logits[3] = float32(math.Inf(-1))
	for trial := 0; trial < 50; trial++ {
		if got := m.sampleTopKTopP(logits, 60, 0); got == 3 {
			t.Fatal("sampled a -Inf token")
		}
	}
}

// TestGenerateSampled_RepetitionPenaltyBreaksLoops: an untrained model
// with greedy-ish settings tends to cycle; a strong penalty must yield
// strictly more distinct tokens than no penalty on the same seed.
func TestGenerateSampled_RepetitionPenaltyBreaksLoops(t *testing.T) {
	distinct := func(penalty float32) int {
		m := samplingTestModel() // fresh model+RNG per run: identical start
		out := m.GenerateSampled([]int{5, 9}, SampleConfig{
			MaxNewTokens:      30,
			MinNewTokens:      30, // keep it generating
			Temperature:       0.1,
			TopK:              3,
			RepetitionPenalty: penalty,
		}, nil)
		seen := map[int]bool{}
		for _, id := range out[2:] {
			seen[id] = true
		}
		return len(seen)
	}

	base := distinct(0)
	penalised := distinct(1.8)
	if penalised <= base {
		t.Errorf("penalty did not increase diversity: %d distinct without vs %d with", base, penalised)
	}
	t.Logf("distinct tokens: %d without penalty, %d with", base, penalised)
}

// TestGenerateSampled_EOSRespected: outside the MinNewTokens window the
// EOS token must terminate generation.
func TestGenerateSampled_EOSRespected(t *testing.T) {
	m := samplingTestModel()
	out := m.GenerateSampled([]int{5}, SampleConfig{
		MaxNewTokens: 40,
		Temperature:  1.0,
		TopK:         60,
	}, nil)
	for i, id := range out[1 : len(out)-1] { // EOS may only be last
		if id == m.Config.EOSTokenID {
			t.Fatalf("EOS at position %d did not stop generation", i+1)
		}
	}
}
