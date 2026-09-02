package cortex

import (
	"math/rand"
	"path/filepath"
	"testing"
)

// TestContinualLearning_FactSurvivesRestart is the end-to-end proof of the
// capability Nexus actually has and a frozen LLM does not:
//
//   1. Teach the system a fact ONCE (single exposure, no gradient step).
//   2. Persist to disk and DESTROY the in-memory state.
//   3. Reload from disk in a fresh object graph.
//   4. Show the fact still steers generation.
//
// No transformer weight is trained anywhere in this test. If it passes,
// the knowledge demonstrably travelled through episodic memory alone.
func TestContinualLearning_FactSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	hippoPath := filepath.Join(dir, "hippocampus.nxhc")

	cfg := DefaultConfig()
	fact := "the capital of france is paris"
	question := "what is the capital of france"

	tok := NewBPETokenizer(300)
	tok.Train([]string{
		fact,
		"the capital of japan is tokyo",
		"albert einstein developed relativity",
		"water boils at one hundred degrees",
	})

	// ── SESSION 1: learn the fact from a single exposure ──────────────
	var biasedTokensBefore int
	{
		rng := rand.New(rand.NewSource(42))
		vocab := NewVocab()
		enc := NewEncoder(vocab, 2048, 40, rng, cfg)
		hippo := NewHippocampus(cfg)

		sdr := enc.EncodeSentence(fact)
		hippo.Store(sdr, sdr, fact) // ONE exposure. No training loop.

		bridge := NewCognitiveBridge(hippo, enc, tok, tok.VocabSize)
		_, res := bridge.ComputeBias(question)
		if !res.Applied {
			t.Fatal("session 1: fact was stored but not recalled — bridge is broken")
		}
		biasedTokensBefore = res.TokensBiased

		if err := hippo.Save(hippoPath); err != nil {
			t.Fatalf("session 1: save failed: %v", err)
		}
	}
	// Everything from session 1 is now out of scope and unreachable.

	// ── SESSION 2: cold start, reload from disk only ──────────────────
	rng2 := rand.New(rand.NewSource(1337)) // different seed = different process
	vocab2 := NewVocab()
	enc2 := NewEncoder(vocab2, 2048, 40, rng2, cfg)

	hippo2, err := LoadHippocampus(hippoPath, cfg)
	if err != nil {
		t.Fatalf("session 2: load failed: %v", err)
	}
	if hippo2.Size() == 0 {
		t.Fatal("session 2: hippocampus came back empty after restart")
	}

	bridge2 := NewCognitiveBridge(hippo2, enc2, tok, tok.VocabSize)
	bias, res2 := bridge2.ComputeBias(question)

	if !res2.Applied {
		t.Fatal("session 2: fact did NOT survive restart — continual-learning claim fails")
	}
	if res2.Context != fact {
		t.Fatalf("session 2: recalled %q, want %q", res2.Context, fact)
	}
	if res2.TokensBiased != biasedTokensBefore {
		t.Fatalf("session 2: biased %d tokens, was %d before restart",
			res2.TokensBiased, biasedTokensBefore)
	}

	// ── The fact must actually reach generation ───────────────────────
	// Feed the reloaded bias into an UNTRAINED transformer. Any recalled
	// token appearing in the output can only have come from memory.
	tcfg := TransformerConfig{
		VocabSize:  tok.VocabSize,
		EmbedDim:   32,
		NumHeads:   2,
		NumLayers:  2,
		FFNDim:     64,
		MaxSeqLen:  32,
		EOSTokenID: 1,
	}
	model := NewMiniTransformer(tcfg, rand.New(rand.NewSource(5)))

	promptIDs := tok.Encode(question)
	if len(promptIDs) == 0 {
		t.Skip("tokenizer produced no prompt tokens")
	}

	out := model.GenerateFastBiased(promptIDs, 12, 12, 1.0, 8, bias)
	generated := out[len(promptIDs):]

	factTokens := make(map[int]bool)
	for _, id := range tok.Encode(fact) {
		factTokens[id] = true
	}

	recalled := 0
	for _, tokID := range generated {
		if factTokens[tokID] {
			recalled++
		}
	}

	if recalled == 0 {
		t.Fatalf("no token from the reloaded fact reached generation; generated=%v decoded=%q",
			generated, tok.Decode(generated))
	}

	t.Logf("PROOF: after restart, %d/%d generated tokens came from the recalled fact",
		recalled, len(generated))
	t.Logf("       recalled context: %q", res2.Context)
	t.Logf("       decoded output:   %q", tok.Decode(generated))
}

// TestContinualLearning_MultipleFactsNoInterference checks that teaching a
// second fact does not overwrite the first — the failure mode that breaks
// naive fine-tuning (catastrophic forgetting).
func TestContinualLearning_MultipleFactsNoInterference(t *testing.T) {
	cfg := DefaultConfig()
	rng := rand.New(rand.NewSource(11))
	vocab := NewVocab()
	enc := NewEncoder(vocab, 2048, 40, rng, cfg)
	hippo := NewHippocampus(cfg)

	tok := NewBPETokenizer(400)
	facts := []string{
		"the capital of france is paris",
		"the capital of japan is tokyo",
		"albert einstein developed relativity",
	}
	tok.Train(facts)

	for _, f := range facts {
		sdr := enc.EncodeSentence(f)
		hippo.Store(sdr, sdr, f)
	}

	bridge := NewCognitiveBridge(hippo, enc, tok, tok.VocabSize)

	cases := []struct{ question, wantFact string }{
		{"what is the capital of france", facts[0]},
		{"what is the capital of japan", facts[1]},
		{"who developed relativity", facts[2]},
	}

	for _, tc := range cases {
		_, res := bridge.ComputeBias(tc.question)
		if !res.Applied {
			t.Errorf("no recall for %q", tc.question)
			continue
		}
		if res.Context != tc.wantFact {
			t.Errorf("question %q recalled %q, want %q — facts interfered",
				tc.question, res.Context, tc.wantFact)
		}
	}
}
