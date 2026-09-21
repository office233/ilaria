package cortex

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// brainLogitsRef mirrors the JSON written by forge/dump_logits.py.
type brainLogitsRef struct {
	BrainDir   string `json:"brain_dir"`
	VocabSize  int    `json:"vocab_size"`
	EOSTokenID int    `json:"eos_token_id"`
	Prompts    []struct {
		Name               string    `json:"name"`
		Text               string    `json:"text"`
		IDs                []int     `json:"ids"`
		LogitsLast         []float32 `json:"logits_last"`
		ArgmaxAll          []int     `json:"argmax_all"`
		GreedyContinuation []int     `json:"greedy_continuation"`
	} `json:"prompts"`
}

// TestForgeBrainEquivalence is the real-brain counterpart to
// TestForgeEquivalence (forge_equivalence_test.go): that test checks a
// tiny synthetic fixture built in-process by forge/make_fixture.py; this
// one checks an actual trained brain directory exported by the forge
// pipeline (transformer.nxtf + tokenizer.json), against a reference
// dump produced by `python forge/dump_logits.py`.
//
// Skipped unless NEXUS_BRAIN_DIR points at a directory containing
// transformer.nxtf, tokenizer.json and logits_ref.json — so CI without
// a real trained brain (or without Python) still passes.
//
//	python forge/dump_logits.py --brain data/forge/brain-a --out data/forge/brain-a/logits_ref.json
//	NEXUS_BRAIN_DIR=data/forge/brain-a go test ./cortex -run TestForgeBrainEquivalence -v
func TestForgeBrainEquivalence(t *testing.T) {
	dir := os.Getenv("NEXUS_BRAIN_DIR")
	if dir == "" {
		t.Skip("NEXUS_BRAIN_DIR not set — skipping real-brain equivalence check")
	}

	nxtfPath := filepath.Join(dir, "transformer.nxtf")
	tokPath := filepath.Join(dir, "tokenizer.json")
	refPath := filepath.Join(dir, "logits_ref.json")
	for _, p := range []string{nxtfPath, tokPath, refPath} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("NEXUS_BRAIN_DIR=%s missing %s (%v) — run: python forge/dump_logits.py --brain %s --out %s",
				dir, filepath.Base(p), err, dir, refPath)
		}
	}

	raw, err := os.ReadFile(refPath)
	if err != nil {
		t.Fatalf("read %s: %v", refPath, err)
	}
	var ref brainLogitsRef
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatalf("parse %s: %v", refPath, err)
	}
	if len(ref.Prompts) == 0 {
		t.Fatal("logits_ref.json has no prompts")
	}

	tok, err := LoadBPETokenizer(tokPath)
	if err != nil {
		t.Fatalf("load tokenizer %s: %v", tokPath, err)
	}
	m, err := LoadMiniTransformer(nxtfPath, rand.New(rand.NewSource(1)))
	if err != nil || m == nil {
		t.Fatalf("load %s: %v (nil=%v)", nxtfPath, err, m == nil)
	}
	if ref.VocabSize != 0 && m.Config.VocabSize != ref.VocabSize {
		t.Fatalf("vocab size mismatch: Go %d vs reference %d", m.Config.VocabSize, ref.VocabSize)
	}

	const tol = 2e-3 // absolute, same tolerance as TestForgeEquivalence

	for _, p := range ref.Prompts {
		p := p
		t.Run(p.Name, func(t *testing.T) {
			ids := p.IDs
			if len(ids) == 0 {
				t.Fatal("reference prompt has no ids")
			}

			// Tokenizer equivalence: re-tokenize the prompt TEXT with the Go
			// tokenizer and confirm it reproduces the exact ids the Python
			// side fed the model. Entries with no text (the --ids-file
			// fixture path, which bypasses tokenization on the Python side
			// because the tiny fixture ships no real tokenizer) skip this
			// half of the check and go straight to the logits comparison.
			if p.Text != "" {
				gotIDs := tok.Encode(p.Text)
				if len(gotIDs) != len(ids) {
					t.Fatalf("tokenizer id-count mismatch: Go %d vs Python %d\n  Go:     %v\n  Python: %v",
						len(gotIDs), len(ids), gotIDs, ids)
				}
				for i := range ids {
					if gotIDs[i] != ids[i] {
						t.Fatalf("tokenizer mismatch at position %d: Go %d vs Python %d\n  Go:     %v\n  Python: %v",
							i, gotIDs[i], ids[i], gotIDs, ids)
					}
				}
			}

			logits := m.Forward(ids)
			T, V := logits.Shape[0], logits.Shape[1]
			if V != len(p.LogitsLast) {
				t.Fatalf("vocab %d vs reference %d", V, len(p.LogitsLast))
			}

			lastRow := logits.Data[(T-1)*V : T*V]
			maxAbs, maxRel := 0.0, 0.0
			for v := 0; v < V; v++ {
				d := math.Abs(float64(lastRow[v] - p.LogitsLast[v]))
				if d > maxAbs {
					maxAbs = d
				}
				if denom := math.Abs(float64(p.LogitsLast[v])); denom > 1e-6 {
					if r := d / denom; r > maxRel {
						maxRel = r
					}
				}
			}

			// Argmax agreement at every position — both sides ran ONE
			// forward pass over the full prompt, so position i's argmax
			// only depends on tokens [0, i], same as a causal model should.
			total := T
			if len(p.ArgmaxAll) < total {
				total = len(p.ArgmaxAll)
			}
			agree := 0
			for pos := 0; pos < total; pos++ {
				row := logits.Data[pos*V : (pos+1)*V]
				bestIdx, bestVal := 0, row[0]
				for v := 1; v < V; v++ {
					if row[v] > bestVal {
						bestVal, bestIdx = row[v], v
					}
				}
				if bestIdx == p.ArgmaxAll[pos] {
					agree++
				}
			}

			t.Logf("%s: max |Δlogit| = %.2e (tol %.0e), max relative Δ = %.2e, argmax agreement %d/%d positions",
				p.Name, maxAbs, tol, maxRel, agree, total)

			if maxAbs > tol {
				t.Fatalf("logits diverge: max |Δ| = %.5f exceeds tolerance %.0e", maxAbs, tol)
			}
			if agree != total {
				t.Fatalf("argmax disagreement: Go and Python agree on only %d/%d positions", agree, total)
			}

			// Greedy continuation: top-k=1 collapses top-k sampling to a
			// pure argmax walk, so this is deterministic and comparable to
			// generate_greedy on the Python side.
			out := m.GenerateFast(ids, len(p.GreedyContinuation), 0.0001, 1)
			gotCont := out[len(ids):]
			if len(gotCont) != len(p.GreedyContinuation) {
				t.Fatalf("greedy continuation length: Go %d vs Python %d (one side stopped early on EOS?)\n  Go:     %v\n  Python: %v",
					len(gotCont), len(p.GreedyContinuation), gotCont, p.GreedyContinuation)
			}
			for i := range gotCont {
				if gotCont[i] != p.GreedyContinuation[i] {
					t.Fatalf("greedy continuation mismatch at token %d: Go %d vs Python %d\n  Go:     %v\n  Python: %v",
						i, gotCont[i], p.GreedyContinuation[i], gotCont, p.GreedyContinuation)
				}
			}
		})
	}
}
