package cortex

import (
	"math/rand"
	"testing"
)

// TestOrganism_BridgeWiring verifies the cognitive bridge is actually
// reachable from the live Organism, not just from unit tests.
//
// This is the difference between "the bridge exists" and "the bridge is
// plugged in". An earlier audit of this repo found ~15 cognitive
// components that were built, tested, and never invoked by the running
// system; these tests exist so the bridge cannot quietly join them.

func TestOrganism_EnsureBridgeNilWhenIncomplete(t *testing.T) {
	// A bare organism has no transformer/tokenizer: biasing must be a
	// no-op rather than a panic, because Broca 1.0 is a valid mode.
	o := &Organism{}
	if br := o.ensureBridge(); br != nil {
		t.Fatal("bridge built despite missing Transformer/Tokenizer")
	}
	if bias := o.cognitiveBias("anything"); bias != nil {
		t.Fatal("bias returned from an organism with no transformer")
	}
}

func TestOrganism_CognitiveBiasReachesLiveRecall(t *testing.T) {
	cfg := DefaultConfig()
	rng := rand.New(rand.NewSource(7))
	org := NewOrganism(cfg, rng)

	// Bring up Broca 2.0 so a transformer and tokenizer exist, mirroring
	// how the real chat path is configured.
	tok := NewBPETokenizer(300)
	tok.Train([]string{
		"the capital of france is paris",
		"the capital of japan is tokyo",
		"albert einstein developed relativity",
	})
	org.Tokenizer = tok
	org.Transformer = NewMiniTransformer(TransformerConfig{
		VocabSize:  tok.VocabSize,
		EmbedDim:   32,
		NumHeads:   2,
		NumLayers:  2,
		FFNDim:     64,
		MaxSeqLen:  32,
		EOSTokenID: 1,
	}, rng)

	if org.Encoder == nil || org.Hippocampus == nil {
		t.Fatal("organism is missing Encoder/Hippocampus; wiring assumption broken")
	}

	// Nothing learned yet — no bias.
	if bias := org.cognitiveBias("what is the capital of france"); bias != nil {
		t.Fatal("bias produced before anything was learned")
	}

	// Teach ONE fact, the way experience would arrive.
	fact := "the capital of france is paris"
	sdr := org.Encoder.EncodeSentence(fact)
	org.Hippocampus.Store(sdr, sdr, fact)

	bias := org.cognitiveBias("what is the capital of france")
	if bias == nil {
		t.Fatal("no bias after storing a directly relevant fact — bridge is not wired")
	}
	if len(bias) != org.Transformer.Config.VocabSize {
		t.Fatalf("bias length %d != transformer vocab %d", len(bias), org.Transformer.Config.VocabSize)
	}

	nonZero := 0
	for _, b := range bias {
		if b != 0 {
			nonZero++
		}
	}
	if nonZero == 0 {
		t.Fatal("bias vector allocated but entirely zero")
	}

	t.Logf("live organism produced bias over %d/%d vocabulary entries",
		nonZero, len(bias))
}

func TestOrganism_BridgeRebuildsOnTokenizerSwap(t *testing.T) {
	// Loading a different checkpoint replaces the tokenizer. A stale
	// bridge would then emit token IDs from the OLD vocabulary — silent
	// corruption. Verify the bridge notices.
	cfg := DefaultConfig()
	rng := rand.New(rand.NewSource(7))
	org := NewOrganism(cfg, rng)

	tokA := NewBPETokenizer(300)
	tokA.Train([]string{"the capital of france is paris"})
	org.Tokenizer = tokA
	org.Transformer = NewMiniTransformer(TransformerConfig{
		VocabSize: tokA.VocabSize, EmbedDim: 32, NumHeads: 2,
		NumLayers: 2, FFNDim: 64, MaxSeqLen: 32, EOSTokenID: 1,
	}, rng)

	first := org.ensureBridge()
	if first == nil {
		t.Fatal("bridge not built for a complete organism")
	}

	// Swap in a different tokenizer, as LoadOrganism would.
	tokB := NewBPETokenizer(400)
	tokB.Train([]string{"albert einstein developed relativity", "water boils at one hundred degrees"})
	org.Tokenizer = tokB
	org.Transformer = NewMiniTransformer(TransformerConfig{
		VocabSize: tokB.VocabSize, EmbedDim: 32, NumHeads: 2,
		NumLayers: 2, FFNDim: 64, MaxSeqLen: 32, EOSTokenID: 1,
	}, rng)

	second := org.ensureBridge()
	if second == nil {
		t.Fatal("bridge disappeared after tokenizer swap")
	}
	if second.Tokenizer != tokB {
		t.Fatal("bridge kept the stale tokenizer — would emit wrong token IDs")
	}
	if second.VocabSize != tokB.VocabSize {
		t.Fatalf("bridge vocab %d != new tokenizer vocab %d", second.VocabSize, tokB.VocabSize)
	}
}
