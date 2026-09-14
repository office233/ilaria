package cortex

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// TestForgeEquivalence is the contract between the PyTorch forge
// (forge/ilaria_model.py) and the Go organism: a model built and
// exported in Python must produce the SAME logits when loaded and run
// here. Both the GPT-2 form and the RoPE+SwiGLU form are checked.
//
// Fixtures come from `python forge/make_fixture.py`; the test skips when
// they are absent so CI without Python still passes.
func TestForgeEquivalence(t *testing.T) {
	for _, name := range []string{"tiny_gpt2", "tiny_modern"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join("..", "forge", "fixtures")
			nxtf := filepath.Join(dir, name+".nxtf")
			meta := filepath.Join(dir, name+".json")
			raw, err := os.ReadFile(meta)
			if err != nil {
				t.Skipf("fixture missing (%v) — run: python forge/make_fixture.py", err)
			}
			var fx struct {
				InputIDs    []int     `json:"input_ids"`
				LogitsLast  []float32 `json:"logits_last"`
				LogitsFirst []float32 `json:"logits_first"`
				ArgmaxLast  int       `json:"argmax_last"`
			}
			if err := json.Unmarshal(raw, &fx); err != nil {
				t.Fatalf("fixture json: %v", err)
			}

			m, err := LoadMiniTransformer(nxtf, rand.New(rand.NewSource(1)))
			if err != nil || m == nil {
				t.Fatalf("load %s: %v (nil=%v)", nxtf, err, m == nil)
			}
			if name == "tiny_modern" && (!m.Config.UseRoPE || !m.Config.UseSwiGLU) {
				t.Fatal("modern fixture lost its architecture flags in the header")
			}

			logits := m.Forward(fx.InputIDs)
			T, V := logits.Shape[0], logits.Shape[1]
			if V != len(fx.LogitsLast) {
				t.Fatalf("vocab %d vs fixture %d", V, len(fx.LogitsLast))
			}
			const tol = 2e-3
			maxDiff := 0.0
			for v := 0; v < V; v++ {
				d := math.Abs(float64(logits.Data[(T-1)*V+v] - fx.LogitsLast[v]))
				if d > maxDiff {
					maxDiff = d
				}
				if d0 := math.Abs(float64(logits.Data[v] - fx.LogitsFirst[v])); d0 > maxDiff {
					maxDiff = d0
				}
			}
			if maxDiff > tol {
				t.Fatalf("Go vs PyTorch logits diverge: max |Δ| = %.5f (tol %.0e)", maxDiff, tol)
			}

			// Argmax agreement end to end through the cached generation path.
			out := m.GenerateFast(fx.InputIDs, 1, 0.0001, 1)
			if got := out[len(out)-1]; got != fx.ArgmaxLast {
				t.Fatalf("greedy next token: Go %d vs PyTorch %d", got, fx.ArgmaxLast)
			}
			t.Logf("%s: max |Δlogit| = %.2e over %d×%d positions — Go and PyTorch agree", name, maxDiff, T, V)
		})
	}
}
