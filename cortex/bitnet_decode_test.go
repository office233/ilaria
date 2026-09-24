package cortex

// bitnet_decode_test.go — the contract between BitNetDecoder (KV-cached
// incremental decoding, bitnet_decode.go) and BitNetModel.Forward's
// whole-sequence recompute (bitnet.go): they must agree on logits at every
// position, and BitNetModel.GenerateGreedy (rewritten to use the decoder)
// must produce exactly what the old O(n²) implementation — kept here as
// naiveGreedy — and the fixture's greedy_continuation both do.
//
// Uses the same tiny fixture as bitnet_equivalence_test.go
// (forge/fixtures/bitnet_tiny.nxtf / .json) and its bitnetRefFile /
// bitnetRefPrompt types.

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

func loadTinyBitNetFixture(t *testing.T) (*BitNetModel, bitnetRefFile) {
	t.Helper()
	dir := filepath.Join("..", "forge", "fixtures")
	nxtfPath := filepath.Join(dir, "bitnet_tiny.nxtf")
	jsonPath := filepath.Join(dir, "bitnet_tiny.json")

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Skipf("fixture missing (%v) — run: python forge/bitnet_reference.py --tiny", err)
	}
	var fx bitnetRefFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if len(fx.Prompts) == 0 {
		t.Fatal("fixture has no prompts")
	}

	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}
	return m, fx
}

func maxAbsDiff32(a, b []float32) float64 {
	if len(a) != len(b) {
		panic("cortex: maxAbsDiff32: length mismatch")
	}
	worst := 0.0
	for i := range a {
		d := math.Abs(float64(a[i]) - float64(b[i]))
		if d > worst {
			worst = d
		}
	}
	return worst
}

// naiveGreedy is the pre-decoder GenerateGreedy algorithm: recompute
// Forward over the whole sequence-so-far at every step. Kept here, byte-
// for-byte, as the reference the decoder-backed GenerateGreedy must match.
func naiveGreedy(m *BitNetModel, prompt []int, maxNew int) []int {
	seq := make([]int, len(prompt))
	copy(seq, prompt)

	for i := 0; i < maxNew; i++ {
		logits := m.Forward(seq)
		last := logits[len(logits)-1]
		best, bestVal := 0, last[0]
		for v := 1; v < len(last); v++ {
			if last[v] > bestVal {
				bestVal = last[v]
				best = v
			}
		}
		seq = append(seq, best)
		if best == m.Cfg.EOSTokenID {
			break
		}
	}
	return seq
}

// (a) Prefill(ids) must equal Forward(ids)[len-1].
func TestBitNetDecoderPrefillMatchesForward(t *testing.T) {
	m, fx := loadTinyBitNetFixture(t)
	const tol = 1e-5

	for pi, p := range fx.Prompts {
		fwd := m.Forward(p.IDs)
		wantLast := fwd[len(fwd)-1]

		dec := NewBitNetDecoder(m)
		got := dec.Prefill(p.IDs)

		if dec.Len() != len(p.IDs) {
			t.Errorf("prompt %d: decoder Len() = %d, want %d", pi, dec.Len(), len(p.IDs))
		}
		if d := maxAbsDiff32(got, wantLast); d > tol {
			t.Errorf("prompt %d: Prefill vs Forward[last] max|Δ| = %.3e (tol %.0e)", pi, d, tol)
		} else {
			t.Logf("prompt %d: Prefill vs Forward[last] max|Δ| = %.3e", pi, d)
		}
	}
}

// (a) Stepping token-by-token from scratch (Prefill(ids[:1]) then Step for
// every following id) must reproduce Forward's per-position logits.
func TestBitNetDecoderStepMatchesForward(t *testing.T) {
	m, fx := loadTinyBitNetFixture(t)
	const tol = 1e-5

	for pi, p := range fx.Prompts {
		if len(p.IDs) < 2 {
			t.Logf("prompt %d: only %d id(s), skipping (need >=2 to exercise Step)", pi, len(p.IDs))
			continue
		}
		fwd := m.Forward(p.IDs)

		dec := NewBitNetDecoder(m)
		got := dec.Prefill(p.IDs[:1])
		if d := maxAbsDiff32(got, fwd[0]); d > tol {
			t.Errorf("prompt %d position 0 (Prefill): max|Δ| = %.3e (tol %.0e)", pi, d, tol)
		}

		worst := 0.0
		for pos := 1; pos < len(p.IDs); pos++ {
			got = dec.Step(p.IDs[pos])
			if dec.Len() != pos+1 {
				t.Errorf("prompt %d position %d: decoder Len() = %d, want %d", pi, pos, dec.Len(), pos+1)
			}
			if d := maxAbsDiff32(got, fwd[pos]); d > tol {
				t.Errorf("prompt %d position %d (Step): max|Δ| = %.3e (tol %.0e)", pi, pos, d, tol)
			} else if d > worst {
				worst = d
			}
		}
		t.Logf("prompt %d: Step-vs-Forward max|Δ| over %d positions = %.3e", pi, len(p.IDs)-1, worst)
	}
}

// (b) BitNetModel.GenerateGreedy (decoder-backed) must produce exactly
// what naiveGreedy (the old O(n²) implementation) produces, and both must
// match the fixture's greedy_continuation.
func TestBitNetGenerateGreedyMatchesNaiveAndFixture(t *testing.T) {
	m, fx := loadTinyBitNetFixture(t)

	for pi, p := range fx.Prompts {
		n := len(p.GreedyContinuation)

		want := naiveGreedy(m, p.IDs, n)
		got := m.GenerateGreedy(p.IDs, n)

		if len(got) != len(want) {
			t.Fatalf("prompt %d: length mismatch: decoder-backed %d vs naive %d", pi, len(got), len(want))
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("prompt %d: token %d: decoder-backed %d vs naive %d (decoder-backed=%v naive=%v)",
					pi, i, got[i], want[i], got, want)
				break
			}
		}

		gotTail := got[len(p.IDs):]
		if len(gotTail) != len(p.GreedyContinuation) {
			t.Errorf("prompt %d: continuation length %d, want %d (fixture) — got=%v", pi, len(gotTail), len(p.GreedyContinuation), gotTail)
			continue
		}
		for i := range gotTail {
			if gotTail[i] != p.GreedyContinuation[i] {
				t.Errorf("prompt %d: continuation token %d: got %d, want %d (fixture) — got=%v want=%v",
					pi, i, gotTail[i], p.GreedyContinuation[i], gotTail, p.GreedyContinuation)
				break
			}
		}
	}
}

// (c) Cache overflow: Prefill with more ids than Cfg.MaxSeqLen, and Step
// once the cache is already at Cfg.MaxSeqLen, must both panic per the
// documented policy in bitnet_decode.go's file doc comment.
func TestBitNetDecoderCacheOverflow(t *testing.T) {
	m, fx := loadTinyBitNetFixture(t)

	// Shallow-copy the model (Layers/Embed are shared, read-only) with an
	// artificially small MaxSeqLen so the guard triggers well within the
	// tiny fixture's short prompts.
	small := *m
	small.Cfg.MaxSeqLen = 3

	p := fx.Prompts[0]
	if len(p.IDs) <= small.Cfg.MaxSeqLen {
		t.Fatalf("fixture prompt 0 has only %d ids, need more than %d to exercise the guard", len(p.IDs), small.Cfg.MaxSeqLen)
	}

	t.Run("PrefillTooLong", func(t *testing.T) {
		dec := NewBitNetDecoder(&small)
		defer func() {
			if recover() == nil {
				t.Fatal("Prefill with len(ids) > Cfg.MaxSeqLen did not panic")
			}
		}()
		dec.Prefill(p.IDs)
	})

	t.Run("StepPastLimit", func(t *testing.T) {
		dec := NewBitNetDecoder(&small)
		dec.Prefill(p.IDs[:small.Cfg.MaxSeqLen]) // fills the cache to exactly MaxSeqLen
		defer func() {
			if recover() == nil {
				t.Fatal("Step once the cache is already at Cfg.MaxSeqLen did not panic")
			}
		}()
		dec.Step(p.IDs[small.Cfg.MaxSeqLen])
	})
}

// Supplementary coverage for the new GenerateSampled: same seed must give
// the same output (determinism), and a caller-supplied stop id distinct
// from Cfg.EOSTokenID must actually stop generation.
func TestBitNetGenerateSampledDeterministicAndStops(t *testing.T) {
	m, fx := loadTinyBitNetFixture(t)
	p := fx.Prompts[0]

	run := func(seed int64) []int {
		rng := rand.New(rand.NewSource(seed))
		return m.GenerateSampled(p.IDs, 5, 0.8, 5, 0.95, 1.1, rng)
	}
	a := run(123)
	b := run(123)
	if len(a) != len(b) {
		t.Fatalf("same-seed runs differ in length: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("same-seed runs diverge at token %d: %v vs %v", i, a, b)
			break
		}
	}

	c := run(999)
	if len(c) == len(a) {
		same := true
		for i := range a {
			if a[i] != c[i] {
				same = false
				break
			}
		}
		if same {
			t.Logf("seed 123 and 999 happened to produce identical output %v (unlikely but not itself a bug)", a)
		}
	}

	// Custom stop id: force it to fire on the very first generated token
	// by using an id we know GenerateGreedy would pick, then reusing it as
	// a stop id for GenerateSampled at temp≈0 (i.e. effectively greedy —
	// temp this low still exercises the sampling code path, unlike
	// GenerateGreedy, since GenerateSampled has no <=1e-6 special case).
	firstGreedy := m.GenerateGreedy(p.IDs, 1)[len(p.IDs)]
	rng := rand.New(rand.NewSource(1))
	out := m.GenerateSampled(p.IDs, 10, 1e-4, 1, 0, 0, rng, firstGreedy)
	if len(out) != len(p.IDs)+1 {
		t.Errorf("custom stopID did not stop generation after 1 token: got %d new tokens (%v)", len(out)-len(p.IDs), out[len(p.IDs):])
	}
	if got := out[len(p.IDs)]; got != firstGreedy {
		t.Errorf("expected the forced stop token %d, got %d", firstGreedy, got)
	}
}
