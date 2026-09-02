package cortex

import (
	"math/rand"
	"testing"
)

// These tests guard the 2026-09 read API for SemanticMemory — the
// module was write-only until then (integration audit gap #2), so any
// regression here silently returns semantic memory to decoration.

// buildTestSemantic creates a semantic memory holding one concept.
// The concept is constructed directly — these tests target the Query
// read APIs, not Generalize (which has its own tests); building the
// concept by hand keeps them deterministic regardless of encoder
// statistics on a two-sentence corpus.
func buildTestSemantic(t *testing.T) (*SemanticMemory, *Encoder) {
	t.Helper()
	cfg := DefaultConfig()
	rng := rand.New(rand.NewSource(77))
	enc := NewEncoder(NewVocab(), cfg.SDRSize, cfg.ActiveCount, rng, cfg)

	e1 := "the drenvolk festival celebrates the copper harvest"
	e2 := "the drenvolk festival celebrates the copper moon"

	sm := NewSemanticMemory(cfg.SDRSize, cfg)
	sm.Concepts = append(sm.Concepts, Concept{
		Prototype: enc.EncodeSentence(e1),
		Count:     2,
		Contexts:  []string{e1, e2},
	})
	return sm, enc
}

// TestSemanticQueryByKeywords: a paraphrased question sharing content
// words must find the concept; unrelated keywords must not.
func TestSemanticQueryByKeywords(t *testing.T) {
	sm, _ := buildTestSemantic(t)

	c, overlap, ok := sm.QueryByKeywords(extractKeywords("what does the drenvolk festival celebrate"), 2)
	if !ok {
		t.Fatal("concept not found for on-topic keywords")
	}
	if overlap < 2 {
		t.Fatalf("overlap = %d, want >= 2", overlap)
	}
	if len(c.Contexts) == 0 {
		t.Fatal("matched concept carries no contexts — bridge would have nothing to bias")
	}

	if _, _, ok := sm.QueryByKeywords(extractKeywords("how tall is the quazmit mountain"), 2); ok {
		t.Fatal("unrelated keywords matched a concept — false-positive recall")
	}
}

// TestSemanticQueryBySDR: the prototype must match a query encoded by
// the SAME encoder that produced the episodes.
func TestSemanticQueryBySDR(t *testing.T) {
	sm, enc := buildTestSemantic(t)

	query := enc.EncodeSentence("the drenvolk festival celebrates the copper harvest")
	if _, sim, ok := sm.Query(query); !ok {
		t.Fatal("prototype did not match a near-identical query SDR")
	} else if sim < sm.SimThreshold {
		t.Fatalf("similarity %d below threshold %d yet reported found", sim, sm.SimThreshold)
	}
}

// TestBridgeSemanticSecondSource: with NO episodic memory, a semantic
// concept alone must still produce a (damped) bias; its boost must not
// exceed MaxBias*SemanticWeight, and an episodic hit must dominate it.
func TestBridgeSemanticSecondSource(t *testing.T) {
	sm, enc := buildTestSemantic(t)

	tok := NewBPETokenizer(300)
	tok.Train([]string{"the drenvolk festival celebrates the copper harvest"})

	emptyHippo := NewHippocampus(DefaultConfig())
	bridge := NewCognitiveBridge(emptyHippo, enc, tok, tok.VocabSize)
	bridge.Semantic = sm

	bias, res := bridge.ComputeBias("what does the drenvolk festival celebrate")
	if !res.SemanticApplied {
		t.Fatal("semantic source not applied despite matching concept")
	}
	if res.Applied {
		t.Fatal("episodic Applied=true with an empty hippocampus")
	}
	if bias == nil || res.TokensBiased == 0 {
		t.Fatal("no bias produced from semantic source alone")
	}
	maxAllowed := bridge.MaxBias * bridge.SemanticWeight
	for i, v := range bias {
		if v > maxAllowed+1e-6 {
			t.Fatalf("semantic-only bias[%d]=%v exceeds damped cap %v", i, v, maxAllowed)
		}
	}

	// Now add the episodic memory: its full-strength boost must exceed
	// the semantic cap for the fact's tokens.
	fact := "the drenvolk festival celebrates the copper harvest"
	sdr := enc.EncodeSentence(fact)
	bridge.Hippo.Store(sdr, sdr, fact)
	bias2, res2 := bridge.ComputeBias("what does the drenvolk festival celebrate")
	if !res2.Applied {
		t.Fatal("episodic memory not recalled after store")
	}
	foundStrong := false
	for _, v := range bias2 {
		if v > maxAllowed+1e-6 {
			foundStrong = true
			break
		}
	}
	if !foundStrong {
		t.Fatal("episodic boost did not exceed the semantic cap — sources are not layered")
	}
}

// TestStemWord_InflectionConsistency guards the recall fix from the
// first continual-bench run: base forms and their inflections must land
// on the same stem, or questions never recall their memories.
func TestStemWord_InflectionConsistency(t *testing.T) {
	pairs := [][2]string{
		{"dance", "dances"},
		{"live", "lives"},
		{"use", "uses"},
		{"memory", "memories"},
		{"celebrate", "celebrates"},
	}
	for _, p := range pairs {
		a, b := stemWord(p[0]), stemWord(p[1])
		if a != b {
			t.Errorf("stems diverge: %q→%q vs %q→%q", p[0], a, p[1], b)
		}
	}
}
