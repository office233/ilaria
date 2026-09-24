package cortex

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────
// BitLinear numerics: (a) int32 tight-loop vs a straightforward float
// reference, and (b) the deliberate rounding-mode difference vs
// torch.round (round-half-to-even) — see bitnet_linear.go's doc comment.
// ─────────────────────────────────────────────────────────────────────

// quantizeRef mirrors quantizeActivationsInt8 but works in float64 and
// takes a pluggable rounding function, so tests can compare against
// round-half-away-from-zero (what BitLinear itself uses) or
// round-half-to-even (what torch.round / HF's ActQuant uses).
func quantizeRef(x []float32, round func(float64) float64) (q []float64, xScale float64) {
	maxAbs := 0.0
	for _, v := range x {
		a := math.Abs(float64(v))
		if a > maxAbs {
			maxAbs = a
		}
	}
	if maxAbs < 1e-5 {
		maxAbs = 1e-5
	}
	quantScale := 127.0 / maxAbs
	xScale = maxAbs / 127.0

	q = make([]float64, len(x))
	for i, v := range x {
		r := round(float64(v) * quantScale)
		if r > 127 {
			r = 127
		} else if r < -128 {
			r = -128
		}
		q[i] = r
	}
	return q, xScale
}

// floatReferenceForward computes BitLinear's y = (quantize_int8(x) @ T^T) *
// (xScale*Scale) as a plain float64 matmul — the "straightforward float
// reference" requirement 3(a) asks for — using the given rounding mode.
func floatReferenceForward(x []float32, ternary [][]int8, scale float32, round func(float64) float64) []float64 {
	q, xScale := quantizeRef(x, round)
	out := make([]float64, len(ternary))
	for o, row := range ternary {
		var sum float64
		for i, w := range row {
			if w != 0 {
				sum += q[i] * float64(w)
			}
		}
		out[o] = sum * xScale * float64(scale)
	}
	return out
}

// relativeL2 accumulates squared-difference and squared-reference-norm
// running totals across many elements/trials; call finish() once at the
// end to get ||got-want||_2 / ||want||_2 over the WHOLE accumulated set.
// A whole-tensor relative L2 norm is used instead of a per-element ratio
// so that individual near-zero reference values (which are common — many
// dot products land close to 0) can't make an otherwise tiny absolute
// difference look like a huge "relative" one.
type relativeL2 struct{ num, den float64 }

func (r *relativeL2) add(got, want []float64) {
	for i := range got {
		d := got[i] - want[i]
		r.num += d * d
		r.den += want[i] * want[i]
	}
}

func (r *relativeL2) finish() float64 {
	if r.den < 1e-12 {
		r.den = 1e-12
	}
	return math.Sqrt(r.num / r.den)
}

func randomTernaryRows(rng *rand.Rand, out, in int) [][]int8 {
	rows := make([][]int8, out)
	for o := range rows {
		row := make([]int8, in)
		for i := range row {
			row[i] = int8(rng.Intn(3) - 1)
		}
		rows[o] = row
	}
	return rows
}

func toFloat64(x []float32) []float64 {
	out := make([]float64, len(x))
	for i, v := range x {
		out[i] = float64(v)
	}
	return out
}

// TestBitLinearIntegerAccumulation proves that BitLinear's int32
// add/subtract tight loop (dotTernaryInt8) is numerically equivalent (well
// under the required <1e-4 relative bound — in practice near machine
// precision, since ternary*int8 sums are exactly representable) to a
// straightforward float reference using the SAME rounding, across several
// shapes including In values that are not multiples of 16 (exercising the
// tile padding).
func TestBitNetLinearIntegerAccumulation(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	shapes := []struct{ in, out int }{
		{16, 8}, {32, 5}, {37, 6}, {1, 3}, {129, 4}, {160, 20},
	}

	var acc relativeL2
	for _, shp := range shapes {
		t.Run(fmt.Sprintf("in%d_out%d", shp.in, shp.out), func(t *testing.T) {
			bl := NewBitLinear(shp.in, shp.out)
			bl.Scale = 0.7 + rng.Float32()*0.6
			ternary := randomTernaryRows(rng, shp.out, shp.in)
			for o, row := range ternary {
				bl.SetRow(o, row)
			}

			x := make([]float32, shp.in)
			for i := range x {
				x[i] = float32(rng.NormFloat64()) * 2
			}

			got := toFloat64(bl.Forward(x))
			want := floatReferenceForward(x, ternary, bl.Scale, math.Round)

			var local relativeL2
			local.add(got, want)
			acc.add(got, want)
			if rel := local.finish(); rel > 1e-4 {
				t.Fatalf("relative L2 diff %.3e > 1e-4 (got=%v want=%v)", rel, got, want)
			}
		})
	}
	t.Logf("int32-accumulation vs float64 reference: overall relative L2 = %.3e (bound 1e-4)", acc.finish())
}

// TestBitLinearRoundingMode measures the OTHER deliberate difference:
// BitLinear rounds activation quantization half-away-from-zero, while
// HF's ActQuant uses torch.round (half-to-even). Across many random
// trials the two are compared via floatReferenceForward with each
// rounding mode; the accumulated relative L2 error must stay under 1e-4,
// which holds because ties (exact .5 boundaries) essentially never occur
// for continuous random floats, so at most a rare ±1 LSB activation
// difference propagates into any one dot product.
func TestBitNetLinearRoundingMode(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	const in, out = 64, 16

	bl := NewBitLinear(in, out)
	bl.Scale = 1.3
	ternary := randomTernaryRows(rng, out, in)
	for o, row := range ternary {
		bl.SetRow(o, row)
	}

	var acc relativeL2
	const trials = 200
	for trial := 0; trial < trials; trial++ {
		x := make([]float32, in)
		for i := range x {
			x[i] = float32(rng.NormFloat64())
		}
		got := toFloat64(bl.Forward(x))                                       // round-half-away-from-zero
		want := floatReferenceForward(x, ternary, bl.Scale, math.RoundToEven) // torch.round
		acc.add(got, want)
	}

	rel := acc.finish()
	t.Logf("round-half-away-from-zero vs round-half-to-even, %d trials: relative L2 = %.3e (bound 1e-4)", trials, rel)
	if rel > 1e-4 {
		t.Fatalf("rounding-mode difference too large: relative L2 %.3e > 1e-4", rel)
	}
}

// ─────────────────────────────────────────────────────────────────────
// Full tiny model vs the PyTorch/transformers fixture
// (forge/bitnet_tiny_reference.py -> forge/fixtures/bitnet_linear_tiny.json)
// ─────────────────────────────────────────────────────────────────────

type bitnetFixtureLinear struct {
	In     int      `json:"in"`
	Out    int      `json:"out"`
	Weight [][]int8 `json:"weight"`
	Scale  float32  `json:"scale"`
}

type bitnetFixtureLayer struct {
	AttnNorm    []float32           `json:"attn_norm"`
	FFNNorm     []float32           `json:"ffn_norm"`
	AttnSubNorm []float32           `json:"attn_sub_norm"`
	FFNSubNorm  []float32           `json:"ffn_sub_norm"`
	Q           bitnetFixtureLinear `json:"q"`
	K           bitnetFixtureLinear `json:"k"`
	V           bitnetFixtureLinear `json:"v"`
	O           bitnetFixtureLinear `json:"o"`
	Gate        bitnetFixtureLinear `json:"gate"`
	Up          bitnetFixtureLinear `json:"up"`
	Down        bitnetFixtureLinear `json:"down"`
}

type bitnetFixtureFile struct {
	Config struct {
		VocabSize  int     `json:"vocab_size"`
		HiddenSize int     `json:"hidden_size"`
		NumLayers  int     `json:"num_layers"`
		NumHeads   int     `json:"num_heads"`
		NumKVHeads int     `json:"num_kv_heads"`
		FFNDim     int     `json:"ffn_dim"`
		RopeTheta  float64 `json:"rope_theta"`
		RMSNormEps float64 `json:"rms_norm_eps"`
	} `json:"config"`
	Embed       [][]float32          `json:"embed"`
	FinalNorm   []float32            `json:"final_norm"`
	Layers      []bitnetFixtureLayer `json:"layers"`
	InputIDs    []int                `json:"input_ids"`
	LogitsLast  []float32            `json:"logits_last"`
	LogitsFirst []float32            `json:"logits_first"`
	ArgmaxLast  int                  `json:"argmax_last"`
}

func buildBitLinearFromFixture(f bitnetFixtureLinear) *BitLinear {
	bl := NewBitLinear(f.In, f.Out)
	bl.Scale = f.Scale
	for o := 0; o < f.Out; o++ {
		bl.SetRow(o, f.Weight[o])
	}
	return bl
}

// TestBitNetTinyModel is the contract between forge/bitnet_tiny_reference.py
// (real transformers BitNet decoder layers + a hand-mirrored offline
// AutoBitLinear) and cortex.BitNetModel: a model described by the fixture
// must produce the same logits when built and run here.
func TestBitNetTinyModel(t *testing.T) {
	path := filepath.Join("..", "forge", "fixtures", "bitnet_linear_tiny.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture missing (%v) — run: python forge/bitnet_tiny_reference.py", err)
	}
	var fx bitnetFixtureFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}

	cfg := BitNetConfig{
		VocabSize:  fx.Config.VocabSize,
		EmbedDim:   fx.Config.HiddenSize,
		NumLayers:  fx.Config.NumLayers,
		NumHeads:   fx.Config.NumHeads,
		NumKVHeads: fx.Config.NumKVHeads,
		FFNDim:     fx.Config.FFNDim,
		MaxSeqLen:  64,
		RopeTheta:  fx.Config.RopeTheta,
		RMSNormEps: fx.Config.RMSNormEps,
	}
	m := NewBitNetModel(cfg)

	if len(fx.Embed) != cfg.VocabSize {
		t.Fatalf("fixture embed rows = %d, want VocabSize %d", len(fx.Embed), cfg.VocabSize)
	}
	for v := 0; v < cfg.VocabSize; v++ {
		copy(m.Embed[v*cfg.EmbedDim:(v+1)*cfg.EmbedDim], fx.Embed[v])
	}
	copy(m.FinalNorm, fx.FinalNorm)

	if len(fx.Layers) != cfg.NumLayers {
		t.Fatalf("fixture has %d layers, want %d", len(fx.Layers), cfg.NumLayers)
	}
	for i, lf := range fx.Layers {
		l := m.Layers[i]
		copy(l.AttnNorm, lf.AttnNorm)
		copy(l.FFNNorm, lf.FFNNorm)
		copy(l.AttnSubNorm, lf.AttnSubNorm)
		copy(l.FFNSubNorm, lf.FFNSubNorm)
		l.Q = buildBitLinearFromFixture(lf.Q)
		l.K = buildBitLinearFromFixture(lf.K)
		l.V = buildBitLinearFromFixture(lf.V)
		l.O = buildBitLinearFromFixture(lf.O)
		l.Gate = buildBitLinearFromFixture(lf.Gate)
		l.Up = buildBitLinearFromFixture(lf.Up)
		l.Down = buildBitLinearFromFixture(lf.Down)
	}

	if got := m.ParamCount(); got <= 0 {
		t.Fatalf("ParamCount() = %d, want > 0", got)
	}

	logits := m.Forward(fx.InputIDs)
	T := len(logits)
	if T != len(fx.InputIDs) {
		t.Fatalf("Forward returned %d rows, want %d", T, len(fx.InputIDs))
	}
	V := cfg.VocabSize
	if len(logits[T-1]) != V {
		t.Fatalf("logits width = %d, want VocabSize %d", len(logits[T-1]), V)
	}

	const tol = 2e-3
	maxDiff := 0.0
	for v := 0; v < V; v++ {
		if d := math.Abs(float64(logits[T-1][v] - fx.LogitsLast[v])); d > maxDiff {
			maxDiff = d
		}
		if d := math.Abs(float64(logits[0][v] - fx.LogitsFirst[v])); d > maxDiff {
			maxDiff = d
		}
	}
	if maxDiff > tol {
		t.Fatalf("Go vs PyTorch logits diverge: max |Δ| = %.5f (tol %.0e)", maxDiff, tol)
	}

	out := m.GenerateGreedy(fx.InputIDs, 1)
	if got := out[len(out)-1]; got != fx.ArgmaxLast {
		t.Fatalf("greedy next token: Go %d vs PyTorch %d", got, fx.ArgmaxLast)
	}

	t.Logf("bitnet_tiny: max |Δlogit| = %.2e over %d positions x %d vocab — Go and PyTorch agree", maxDiff, T, V)
}
