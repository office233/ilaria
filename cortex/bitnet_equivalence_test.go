package cortex

// bitnet_equivalence_test.go — the contract between the real
// `transformers` BitNet implementation and the Go engine
// (cortex/bitnet.go, cortex/bitnet_linear.go, cortex/bitnet_persist.go).
//
// TestBitNetTinyEquivalence always runs: it loads
// forge/fixtures/bitnet_tiny.nxtf (a 2-layer, hidden-32 synthetic BitNet
// with ONLINE ternary quantization, exported by
// `python forge/bitnet_reference.py --tiny`) and checks Forward/
// GenerateGreedy against forge/fixtures/bitnet_tiny.json. This exercises
// the whole chain — quantize -> PackTernaryTile -> NXTF v3 -> Go load ->
// Go forward — without the 2.4B checkpoint, so it runs in CI with no
// Python and no GPU.
//
// TestBitNetEquivalence is skipped unless NEXUS_BITNET_DIR (an absolute
// path) is set to a directory containing bitnet.nxtf + logits_ref.json —
// produced by:
//
//	python forge/import_bitnet.py --hf-dir data/pretrained/bitnet-b1.58-2B-4T --out <dir>/bitnet.nxtf
//	python forge/bitnet_reference.py --hf-dir data/pretrained/bitnet-b1.58-2B-4T --out-dir <dir>
//
// go test's working directory is the package directory (cortex/), so both
// tests build fixture paths accordingly (relative for the tiny fixture,
// straight from the env var — already absolute per its contract — for the
// real one).

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// bitnetRefPrompt is one entry of the reference JSON's "prompts" list,
// shared by both bitnet_tiny.json and logits_ref.json.
type bitnetRefPrompt struct {
	Text               *string   `json:"text"`
	IDs                []int     `json:"ids"`
	LogitsLast         []float64 `json:"logits_last"`
	Argmax             []int     `json:"argmax"`
	GreedyContinuation []int     `json:"greedy_continuation"`
}

type bitnetRefFile struct {
	Prompts []bitnetRefPrompt `json:"prompts"`
}

// checkPrompt runs m.Forward and m.GenerateGreedy on one reference prompt
// and reports every mismatch found (rather than stopping at the first) so
// a failure shows the full picture.
func checkPrompt(t *testing.T, m *BitNetModel, label string, p bitnetRefPrompt, tol float64) float64 {
	t.Helper()

	logits := m.Forward(p.IDs)
	T := len(logits)
	if T != len(p.IDs) {
		t.Fatalf("%s: Forward returned %d positions, want %d", label, T, len(p.IDs))
	}
	V := len(logits[0])
	if V != len(p.LogitsLast) {
		t.Fatalf("%s: vocab %d vs fixture logits_last len %d", label, V, len(p.LogitsLast))
	}

	last := logits[T-1]
	maxDiff := 0.0
	for v := 0; v < V; v++ {
		d := math.Abs(float64(last[v]) - p.LogitsLast[v])
		if d > maxDiff {
			maxDiff = d
		}
	}
	if maxDiff > tol {
		t.Errorf("%s: last-position logits diverge: max |Δ| = %.5f (tol %.0e)", label, maxDiff, tol)
	}

	if len(p.Argmax) != T {
		t.Fatalf("%s: fixture has %d argmax entries, want %d", label, len(p.Argmax), T)
	}
	for t2 := 0; t2 < T; t2++ {
		row := logits[t2]
		best, bestVal := 0, row[0]
		for v := 1; v < V; v++ {
			if row[v] > bestVal {
				bestVal = row[v]
				best = v
			}
		}
		if best != p.Argmax[t2] {
			t.Errorf("%s: argmax at position %d: Go %d vs PyTorch %d", label, t2, best, p.Argmax[t2])
		}
	}

	gotFull := m.GenerateGreedy(p.IDs, len(p.GreedyContinuation))
	gotTail := gotFull[len(p.IDs):]
	if len(gotTail) != len(p.GreedyContinuation) {
		t.Errorf("%s: greedy continuation length: Go %d vs PyTorch %d (Go may have hit EOS early: %v)",
			label, len(gotTail), len(p.GreedyContinuation), gotTail)
	} else {
		for i := range gotTail {
			if gotTail[i] != p.GreedyContinuation[i] {
				t.Errorf("%s: greedy continuation token %d: Go %d vs PyTorch %d (Go=%v PyTorch=%v)",
					label, i, gotTail[i], p.GreedyContinuation[i], gotTail, p.GreedyContinuation)
				break
			}
		}
	}

	return maxDiff
}

func TestBitNetTinyEquivalence(t *testing.T) {
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

	const tol = 2e-3
	worst := 0.0
	for _, p := range fx.Prompts {
		d := checkPrompt(t, m, "tiny", p, tol)
		if d > worst {
			worst = d
		}
	}
	t.Logf("tiny: %d prompts, max |Δlogit| = %.2e over all prompts (tol %.0e) — Go and PyTorch agree", len(fx.Prompts), worst, tol)
}

// TestBitNetEquivalence checks the real 2.4B microsoft/bitnet-b1.58-2B-4T
// checkpoint. Skipped unless NEXUS_BITNET_DIR points at a directory with
// bitnet.nxtf + logits_ref.json (see file doc comment for how to produce
// them) — this test never touches the network and never builds the NXTF
// file itself, so it stays fast and deterministic once the fixtures exist.
func TestBitNetEquivalence(t *testing.T) {
	dir := os.Getenv("NEXUS_BITNET_DIR")
	if dir == "" {
		t.Skip("NEXUS_BITNET_DIR not set — skipping real-checkpoint equivalence test")
	}
	nxtfPath := filepath.Join(dir, "bitnet.nxtf")
	jsonPath := filepath.Join(dir, "logits_ref.json")

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("read %s: %v", jsonPath, err)
	}
	var fx bitnetRefFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if len(fx.Prompts) == 0 {
		t.Fatal("fixture has no prompts")
	}

	loadStart := time.Now()
	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}
	loadElapsed := time.Since(loadStart)
	t.Logf("load: %s (%s)", loadElapsed, nxtfPath)

	// The 2.4B model quantizes activations to int8 in all 210 linear layers,
	// so a float32 summation-order difference can flip a rounding bucket
	// and the flip compounds through 30 residual layers. Measured on
	// 2026-09-24: the SAME PyTorch weights run with 1 vs 4 BLAS threads
	// differ by max |Δlogit| = 0.37 at the last position (argmax identical);
	// Go vs PyTorch differed by 0.27–0.99 with argmax agreement 45/46.
	// Per-logit tolerances are therefore meaningless at this scale; the
	// criteria below compare the predictive distributions instead, while
	// TestBitNetTinyEquivalence keeps the strict 2e-3 check on the same
	// Go code path.
	const (
		maxKL          = 0.03 // nats, KL(PyTorch ‖ Go) at the last position (measured 0.007–0.016)
		maxMeanAbs     = 0.30 // mean |Δlogit| over the 128k vocabulary (measured 0.08–0.21)
		maxAbs         = 2.0  // any single logit
		minArgmaxAgree = 0.95 // over all positions of all prompts
		greedyPrefix   = 2    // first greedy tokens must match on every prompt
	)
	agree, total := 0, 0
	fwdStart := time.Now()
	for _, p := range fx.Prompts {
		label := "real"
		if p.Text != nil {
			label = *p.Text
		}
		logits := m.Forward(p.IDs)
		T := len(logits)
		if T != len(p.IDs) || len(p.Argmax) != T {
			t.Fatalf("%s: Forward returned %d positions, want %d (fixture argmax %d)", label, T, len(p.IDs), len(p.Argmax))
		}
		last := logits[T-1]
		V := len(last)
		if V != len(p.LogitsLast) {
			t.Fatalf("%s: vocab %d vs fixture logits_last len %d", label, V, len(p.LogitsLast))
		}
		kl, meanAbs, maxDiff := distributionGap(p.LogitsLast, last)
		if kl > maxKL || meanAbs > maxMeanAbs || maxDiff > maxAbs {
			t.Errorf("%s: distributions diverge: KL=%.4f (max %.2f) mean|Δ|=%.4f (max %.2f) max|Δ|=%.3f (max %.1f)",
				label, kl, maxKL, meanAbs, maxMeanAbs, maxDiff, maxAbs)
		}
		for pos := 0; pos < T; pos++ {
			if argmaxRow(logits[pos]) == p.Argmax[pos] {
				agree++
			}
			total++
		}
		n := greedyPrefix
		if n > len(p.GreedyContinuation) {
			n = len(p.GreedyContinuation)
		}
		got := m.GenerateGreedy(p.IDs, n)[len(p.IDs):]
		for i := 0; i < n && i < len(got); i++ {
			if got[i] != p.GreedyContinuation[i] {
				t.Errorf("%s: greedy token %d: Go %d vs PyTorch %d", label, i, got[i], p.GreedyContinuation[i])
				break
			}
		}
		t.Logf("%s: KL=%.4f mean|Δ|=%.4f max|Δ|=%.3f greedy[:%d]=%v", label, kl, meanAbs, maxDiff, n, got)
	}
	fwdElapsed := time.Since(fwdStart)
	rate := float64(agree) / float64(total)
	if rate < minArgmaxAgree {
		t.Errorf("argmax agreement %d/%d = %.1f%% below %.0f%%", agree, total, 100*rate, 100*minArgmaxAgree)
	}
	t.Logf("real: %d prompts, argmax agreement %d/%d (%.1f%%), load=%s, forward+greedy=%s",
		len(fx.Prompts), agree, total, 100*rate, loadElapsed, fwdElapsed)
}

// distributionGap compares a reference logit row with the engine's row:
// KL(softmax(ref) ‖ softmax(got)) in nats, mean and max |Δlogit|.
func distributionGap(ref []float64, got []float32) (kl, meanAbs, maxAbs float64) {
	V := len(ref)
	maxR, maxG := ref[0], float64(got[0])
	for v := 1; v < V; v++ {
		if ref[v] > maxR {
			maxR = ref[v]
		}
		if float64(got[v]) > maxG {
			maxG = float64(got[v])
		}
	}
	zR, zG := 0.0, 0.0
	for v := 0; v < V; v++ {
		zR += math.Exp(ref[v] - maxR)
		zG += math.Exp(float64(got[v]) - maxG)
	}
	sumAbs := 0.0
	for v := 0; v < V; v++ {
		lpR := ref[v] - maxR - math.Log(zR)
		lpG := float64(got[v]) - maxG - math.Log(zG)
		kl += math.Exp(lpR) * (lpR - lpG)
		d := math.Abs(ref[v] - float64(got[v]))
		sumAbs += d
		if d > maxAbs {
			maxAbs = d
		}
	}
	return kl, sumAbs / float64(V), maxAbs
}

func argmaxRow(row []float32) int {
	best := 0
	for v := 1; v < len(row); v++ {
		if row[v] > row[best] {
			best = v
		}
	}
	return best
}
