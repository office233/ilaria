package main

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	cortex "nexus-cortex/cortex"
)

// constantForward returns a forwardFunc that ignores its input and always
// scores every position with the same logits row L (repeated). Lets tests
// pin down the exact expected NLL analytically without a real model.
func constantForward(l []float32) forwardFunc {
	v := len(l)
	return func(input []int) *cortex.Tensor {
		data := make([]float32, len(input)*v)
		for i := range input {
			copy(data[i*v:(i+1)*v], l)
		}
		return cortex.NewTensorFrom(data, len(input), v)
	}
}

func logSumExp(l []float32) float64 {
	max := float64(l[0])
	for _, v := range l[1:] {
		if float64(v) > max {
			max = float64(v)
		}
	}
	sum := 0.0
	for _, v := range l {
		sum += math.Exp(float64(v) - max)
	}
	return max + math.Log(sum)
}

// ── splitDocuments ──────────────────────────────────────────────────────

func TestSplitDocuments(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"single", "hello world", []string{"hello world"}},
		{"two docs", "doc one\nline2\n\ndoc two", []string{"doc one\nline2", "doc two"}},
		{"multi blank", "a\n\n\n\nb", []string{"a", "b"}},
		{"leading/trailing blank", "\n\nfirst\n\nsecond\n\n", []string{"first", "second"}},
		{"crlf", "a\r\n\r\nb", []string{"a", "b"}},
		{"empty", "", nil},
		{"only blank", "\n\n\n", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := splitDocuments(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("got %d docs %q, want %d docs %q", len(got), got, len(c.want), c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("doc %d: got %q want %q", i, got[i], c.want[i])
				}
			}
		})
	}
}

// ── buildIDsFromIDsFile ─────────────────────────────────────────────────

func TestBuildIDsFromIDsFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ids.txt")
	if err := os.WriteFile(path, []byte("3 1  4\n1\t5 9\n"), 0644); err != nil {
		t.Fatal(err)
	}
	ids, spans, err := buildIDsFromIDsFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []int{3, 1, 4, 1, 5, 9}
	if len(ids) != len(want) {
		t.Fatalf("got %v want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("got %v want %v", ids, want)
		}
	}
	if len(spans) != 1 || spans[0] != (docSpan{Start: 0, End: 6}) {
		t.Fatalf("unexpected spans: %+v", spans)
	}
}

func TestBuildIDsFromIDsFileRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ids.txt")
	if err := os.WriteFile(path, []byte("1 2 x 3"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := buildIDsFromIDsFile(path); err == nil {
		t.Fatal("expected an error for a non-integer field")
	}
}

// ── computePerplexity: windowing bookkeeping ────────────────────────────

// TestComputePerplexity_UniformLogits checks window/token counts and the
// exact ln(V) NLL a uniform-logit "model" must produce, including a
// final partial window (dropped if <2 tokens, kept and truncated otherwise)
// and per-document attribution when a window's predicted range straddles a
// document boundary.
func TestComputePerplexity_UniformLogits(t *testing.T) {
	const vocab = 3
	uniform := constantForward([]float32{0, 0, 0})
	ids := make([]int, 10) // values irrelevant: logits are uniform over vocab
	for i := range ids {
		ids[i] = i % vocab
	}
	// Straddling doc split: doc0 = [0,6), doc1 = [6,10).
	spans := []docSpan{{Start: 0, End: 6}, {Start: 6, End: 10}}

	res := computePerplexity(ids, spans, 4, uniform)

	// Windows: [0,4) w=4 -> 3 predicted; [4,8) w=4 -> 3 predicted;
	// [8,10) w=2 -> 1 predicted. Total predicted = 7, windows = 3.
	if res.Windows != 3 {
		t.Errorf("windows = %d, want 3", res.Windows)
	}
	if res.Tokens != 7 {
		t.Errorf("tokens = %d, want 7", res.Tokens)
	}
	wantNLL := math.Log(vocab)
	if math.Abs(res.MeanNLL-wantNLL) > 1e-6 {
		t.Errorf("mean_nll = %v, want %v", res.MeanNLL, wantNLL)
	}
	wantPPL := math.Exp(wantNLL)
	if math.Abs(res.Perplexity-wantPPL) > 1e-6 {
		t.Errorf("ppl = %v, want %v", res.Perplexity, wantPPL)
	}

	// Predicted target indices per window: {1,2,3}, {5,6,7}, {9}.
	// doc0 = [0,6) owns 1,2,3,5 -> 4 tokens (note: window [4,8)'s
	// predicted range 5,6,7 straddles the doc0/doc1 boundary at 6).
	// doc1 = [6,10) owns 6,7,9 -> 3 tokens.
	if len(res.PerDoc) != 2 {
		t.Fatalf("per_doc = %+v, want 2 entries", res.PerDoc)
	}
	if res.PerDoc[0].Doc != 0 || res.PerDoc[0].Tokens != 4 {
		t.Errorf("doc0 = %+v, want tokens=4", res.PerDoc[0])
	}
	if res.PerDoc[1].Doc != 1 || res.PerDoc[1].Tokens != 3 {
		t.Errorf("doc1 = %+v, want tokens=3", res.PerDoc[1])
	}
	for _, d := range res.PerDoc {
		if math.Abs(d.MeanNLL-wantNLL) > 1e-6 {
			t.Errorf("doc %d mean_nll = %v, want %v", d.Doc, d.MeanNLL, wantNLL)
		}
	}
}

// TestComputePerplexity_DropsShortFinalWindow checks that a final window of
// exactly 1 token (0 predictions) is dropped rather than counted as a
// zero-token window, and that an exact multiple of ctx leaves no remainder
// window at all.
func TestComputePerplexity_DropsShortFinalWindow(t *testing.T) {
	uniform := constantForward([]float32{1, 2})
	ids := []int{0, 1, 0, 1, 0} // len 5, ctx 4 -> windows [0,4) w=4, [4,5) w=1 (dropped)
	res := computePerplexity(ids, []docSpan{{Start: 0, End: 5}}, 4, uniform)
	if res.Windows != 1 {
		t.Errorf("windows = %d, want 1 (trailing 1-token window must be dropped)", res.Windows)
	}
	if res.Tokens != 3 {
		t.Errorf("tokens = %d, want 3", res.Tokens)
	}

	ids2 := []int{0, 1, 0, 1} // len 4, ctx 4 -> exactly one window, no remainder
	res2 := computePerplexity(ids2, []docSpan{{Start: 0, End: 4}}, 4, uniform)
	if res2.Windows != 1 || res2.Tokens != 3 {
		t.Errorf("got windows=%d tokens=%d, want windows=1 tokens=3", res2.Windows, res2.Tokens)
	}
}

// TestComputePerplexity_MatchesAnalyticNLL uses fixed (non-uniform) logits
// repeated at every position and checks the aggregate mean_nll against an
// NLL computed directly from log-softmax, independent of computePerplexity.
// It also checks that splitting the same token stream into many small
// documents (forcing several windows to straddle document boundaries)
// leaves the aggregate tokens/mean_nll unchanged — i.e. doc attribution
// bookkeeping doesn't perturb the overall total.
func TestComputePerplexity_MatchesAnalyticNLL(t *testing.T) {
	l := []float32{0, 1, 2, 3}
	forward := constantForward(l)
	ids := []int{0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3}
	const ctx = 5

	whole := computePerplexity(ids, []docSpan{{Start: 0, End: len(ids)}}, ctx, forward)

	// Same ids, chopped into 2-token "documents".
	var chopped []docSpan
	for i := 0; i < len(ids); i += 2 {
		end := i + 2
		if end > len(ids) {
			end = len(ids)
		}
		chopped = append(chopped, docSpan{Start: i, End: end})
	}
	split := computePerplexity(ids, chopped, ctx, forward)

	if whole.Tokens != split.Tokens {
		t.Fatalf("token totals differ under doc splitting: %d vs %d", whole.Tokens, split.Tokens)
	}
	if math.Abs(whole.MeanNLL-split.MeanNLL) > 1e-6 {
		t.Fatalf("mean_nll differs under doc splitting: %v vs %v", whole.MeanNLL, split.MeanNLL)
	}
	// Per-doc tokens must sum back to the whole.
	sum := 0
	for _, d := range split.PerDoc {
		sum += d.Tokens
	}
	if sum != split.Tokens {
		t.Fatalf("per-doc token counts sum to %d, want %d", sum, split.Tokens)
	}

	// Independent expected value: windows are [0,5) w=5 -> targets
	// ids[1:5]; [5,10) w=5 -> targets ids[6:10]; [10,12) w=2 -> targets
	// ids[11:12]. (First token of every window has no prediction.)
	wantTargets := []int{}
	wantTargets = append(wantTargets, ids[1:5]...)
	wantTargets = append(wantTargets, ids[6:10]...)
	wantTargets = append(wantTargets, ids[11:12]...)

	lse := logSumExp(l)
	var sumNLL float64
	for _, tgt := range wantTargets {
		sumNLL += -(float64(l[tgt]) - lse)
	}
	wantMean := sumNLL / float64(len(wantTargets))

	if whole.Tokens != len(wantTargets) {
		t.Fatalf("tokens = %d, want %d", whole.Tokens, len(wantTargets))
	}
	if math.Abs(whole.MeanNLL-wantMean) > 1e-6 {
		t.Fatalf("mean_nll = %v, want %v (analytic)", whole.MeanNLL, wantMean)
	}
}

// TestComputePerplexity_NoDocsStillWorks exercises an empty docSpans slice
// (e.g. an empty text file never reaches computePerplexity in main, but the
// function itself must not panic).
func TestComputePerplexity_NoDocsStillWorks(t *testing.T) {
	uniform := constantForward([]float32{0, 0})
	res := computePerplexity([]int{0, 1, 0, 1}, nil, 4, uniform)
	if res.Tokens != 3 {
		t.Errorf("tokens = %d, want 3", res.Tokens)
	}
	if len(res.PerDoc) != 0 {
		t.Errorf("per_doc = %+v, want none (no doc spans supplied)", res.PerDoc)
	}
}
