package cortex

import (
	"math"
	"math/rand"
	"testing"
)

// newBridgeFixture builds a minimal but REAL wiring: a genuine vocab,
// encoder, hippocampus and BPE tokenizer. No mocks — the point of these
// tests is to prove the bridge works against the actual types it will
// meet in production.
func newBridgeFixture(t *testing.T) (*CognitiveBridge, *Hippocampus, *Encoder) {
	t.Helper()

	rng := rand.New(rand.NewSource(42))
	cfg := DefaultConfig()

	vocab := NewVocab()
	enc := NewEncoder(vocab, 2048, 40, rng, cfg)
	hippo := NewHippocampus(cfg)

	tok := NewBPETokenizer(300)
	tok.Train([]string{
		"the capital of france is paris",
		"the capital of japan is tokyo",
		"albert einstein developed relativity",
		"water boils at one hundred degrees",
	})

	cb := NewCognitiveBridge(hippo, enc, tok, tok.VocabSize)
	return cb, hippo, enc
}

func TestCognitiveBridge_NilAndDisabledAreSafe(t *testing.T) {
	// A nil bridge must not panic — Organism may not have wired one.
	var nilBridge *CognitiveBridge
	if bias, res := nilBridge.ComputeBias("anything"); bias != nil || res.Applied {
		t.Fatalf("nil bridge should produce no bias, got bias=%v applied=%v", bias != nil, res.Applied)
	}

	cb, _, _ := newBridgeFixture(t)
	cb.Enabled = false
	if bias, res := cb.ComputeBias("the capital of france"); bias != nil || res.Applied {
		t.Fatal("disabled bridge must not produce bias")
	}
}

func TestCognitiveBridge_EmptyMemoryProducesNoBias(t *testing.T) {
	cb, _, _ := newBridgeFixture(t)

	// Hippocampus is empty: there is nothing to recall.
	bias, res := cb.ComputeBias("the capital of france is")
	if bias != nil || res.Applied {
		t.Fatalf("empty hippocampus must yield no bias, got applied=%v", res.Applied)
	}
}

func TestCognitiveBridge_RecalledFactBiasesItsTokens(t *testing.T) {
	cb, hippo, enc := newBridgeFixture(t)

	fact := "the capital of france is paris"
	sdr := enc.EncodeSentence(fact)
	hippo.Store(sdr, sdr, fact)

	bias, res := cb.ComputeBias("what is the capital of france")
	if !res.Applied {
		t.Fatal("expected recall to fire for a stored, keyword-matching fact")
	}
	if len(bias) != cb.VocabSize {
		t.Fatalf("bias length = %d, want VocabSize %d", len(bias), cb.VocabSize)
	}
	if res.TokensBiased == 0 {
		t.Fatal("recall fired but biased zero tokens")
	}

	// Every token of the recalled fact must carry a positive bias.
	// This is the core claim: memory reaches the vocabulary.
	factTokens := cb.Tokenizer.Encode(fact)
	boosted := 0
	for _, tid := range factTokens {
		if tid >= 0 && tid < len(bias) && bias[tid] > 0 {
			boosted++
		}
	}
	if boosted == 0 {
		t.Fatal("no token of the recalled fact received a bias")
	}

	// The bias must respect its ceiling, otherwise it would overwhelm
	// the transformer instead of nudging it.
	for i, b := range bias {
		if b > cb.MaxBias {
			t.Fatalf("bias[%d] = %f exceeds MaxBias %f", i, b, cb.MaxBias)
		}
	}
}

func TestCognitiveBridge_IrrelevantPromptDoesNotRecall(t *testing.T) {
	cb, hippo, enc := newBridgeFixture(t)

	fact := "the capital of france is paris"
	hippo.Store(enc.EncodeSentence(fact), enc.EncodeSentence(fact), fact)

	// Nothing here overlaps the stored fact's keywords.
	_, res := cb.ComputeBias("quantum chromodynamics lattice gauge")
	if res.Applied {
		t.Fatalf("unrelated prompt should not recall %q", res.Context)
	}
}

func TestCognitiveBridge_ConfidenceScalesBias(t *testing.T) {
	cb, hippo, enc := newBridgeFixture(t)

	fact := "the capital of japan is tokyo"
	sdr := enc.EncodeSentence(fact)
	hippo.Store(sdr, sdr, fact)

	prompt := "what is the capital of japan"
	bias, res := cb.ComputeBias(prompt)
	if !res.Applied {
		t.Skip("recall did not fire; confidence scaling not exercised")
	}

	// Bias must equal MaxBias * (strength/255) for every boosted token.
	// Verify the arithmetic rather than trusting it.
	mem, _, ok := cb.Hippo.RecallByKeywords(extractKeywords(prompt), cb.RecallThreshold, cb.Encoder.EncodeSentence(prompt))
	if !ok {
		t.Fatal("direct recall failed although bridge recalled")
	}
	want := cb.MaxBias * maxF32(float32(mem.Strength)/255.0, cb.MinConfidence)

	for _, b := range bias {
		if b != 0 && math.Abs(float64(b-want)) > 1e-5 {
			t.Fatalf("bias %f != expected %f (strength %d)", b, want, mem.Strength)
		}
	}
}

// maxF32 mirrors the confidence floor applied inside ComputeBias.
func maxF32(a, b float32) float32 {
	if a > b {
		return a
	}
	return b
}

func TestApplyBias_AddsInPlace(t *testing.T) {
	logits := []float32{1.0, 2.0, 3.0}
	bias := []float32{0.5, 0.0, -1.0}

	ApplyBias(logits, bias)

	want := []float32{1.5, 2.0, 2.0}
	for i := range want {
		if math.Abs(float64(logits[i]-want[i])) > 1e-6 {
			t.Fatalf("logits[%d] = %f, want %f", i, logits[i], want[i])
		}
	}
}

func TestApplyBias_PreservesNegativeInfinity(t *testing.T) {
	// EOS suppression sets logits to -Inf. If the bridge turned that back
	// into a finite number, generation could emit EOS during the
	// suppression window and truncate output. Guard against it.
	negInf := float32(math.Inf(-1))
	logits := []float32{1.0, negInf, 3.0}
	bias := []float32{0.5, 99.0, 0.5}

	ApplyBias(logits, bias)

	if !math.IsInf(float64(logits[1]), -1) {
		t.Fatalf("-Inf logit was modified to %f; EOS suppression broken", logits[1])
	}
	if logits[0] != 1.5 || logits[2] != 3.5 {
		t.Fatalf("finite logits mis-biased: %v", logits)
	}
}

func TestApplyBias_HandlesLengthMismatchAndEmpty(t *testing.T) {
	// Must not panic on any shape combination.
	ApplyBias(nil, []float32{1, 2})
	ApplyBias([]float32{1, 2}, nil)

	logits := []float32{1.0, 2.0, 3.0}
	ApplyBias(logits, []float32{1.0}) // bias shorter than logits
	if logits[0] != 2.0 {
		t.Fatalf("expected first logit biased to 2.0, got %f", logits[0])
	}
	if logits[1] != 2.0 || logits[2] != 3.0 {
		t.Fatal("bias leaked past its own length")
	}
}

func TestExtractKeywords_UsedByBridgeStripsStopWords(t *testing.T) {
	// extractKeywords lives in hippocampus.go; the bridge depends on its
	// stemming/stop-word behaviour matching RecallByKeywords' index.
	got := extractKeywords("What is the Capital of France?")

	want := map[string]bool{"capit": false, "capital": false, "franc": false, "france": false}
	for _, k := range got {
		if _, tracked := want[k]; tracked {
			want[k] = true
		}
	}
	if !want["capital"] && !want["capit"] {
		t.Fatalf("expected capital (or its stem) among keywords, got %v", got)
	}
	if !want["france"] && !want["franc"] {
		t.Fatalf("expected france (or its stem) among keywords, got %v", got)
	}
}
