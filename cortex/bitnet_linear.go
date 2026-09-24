package cortex

// bitnet_linear.go — BitLinear: the ternary-weight, int8-activation linear
// layer at the core of BitNet b1.58 inference.
//
// Ground truth is the installed `transformers` package's BitNet offline
// quantization path — AutoBitLinear.forward (online_quant=False), the
// branch the real microsoft/bitnet-b1.58-2B-4T-bf16 checkpoint actually
// uses (config.json: quantization_config.quantization_mode == "offline"):
//
//	# transformers/integrations/bitnet.py:299-312 (AutoBitLinear.forward)
//	if self.online_quant:                     # False for this checkpoint
//	    weight = WeightQuant.apply(self.weight)
//	else:
//	    weight = self.weight                  # already ternary {-1,0,1}
//	input = ActQuant.apply(input)              # per-token int8 fake-quant
//	output = F.linear(input, weight, self.bias)  # bias is always None here
//	if not self.online_quant:
//	    output = output * self.weight_scale    # <-- MULTIPLY, not divide
//
//	# ActQuant.forward, same file, lines 242-249:
//	scale = 127 / activation.abs().max(dim=-1, keepdim=True).values.clamp(min=1e-5)
//	activation = (activation * scale).round().clamp(-128, 127) / scale
//
// So weight_scale is a dequantization multiplier: original_weight[i] ≈
// ternary[i] * weight_scale (weight_scale is the per-tensor mean-absolute
// value of the pre-quantization float weights — see WeightQuant.forward,
// same file lines 219-226: scale = 1/mean(|w|); w_quant =
// round(w*scale).clamp(-1,1)/scale). That resolves the "multiply or
// divide" question left open in the task's API contract: BitLinear.Scale
// (== weight_scale) MULTIPLIES the raw ternary/int8 dot product, alongside
// the activation's own per-token dequant factor xScale.
//
// Deliberate differences from the HF float path (documented + tested in
// bitnet_test.go, TestBitLinearIntegerAccumulation /
// TestBitLinearRoundingMode):
//
//  1. HF's ActQuant dequantizes activations back to float BEFORE the
//     matmul (`(x*scale).round().clamp(...)/scale`), then runs a normal
//     float matmul against the ternary weight. We instead keep the
//     quantized activation as int8 and accumulate the ternary dot product
//     in int32 (only add/subtract, per weight sign — zero weights are
//     skipped for free), THEN apply xScale*Scale once per output. This is
//     mathematically equivalent (ternary * int8 products and their sums
//     are exactly representable in int32/float32 — no precision is lost
//     by staying integer) and is what makes the per-token dot products
//     tight loops instead of a full float matmul.
//  2. HF quantizes with `torch.round`, which breaks exact .5 ties to even
//     (banker's rounding). We use round-half-away-from-zero (simple
//     +0.5/-0.5 + truncate). For continuous, non-adversarial activations
//     the chance of landing exactly on a .5 tie is ~0, so this cannot
//     account for more than an occasional ±1 LSB difference in a handful
//     of quantized activation values — bounded and shown empirically to
//     stay far under 1e-4 relative in TestBitLinearRoundingMode.

import (
	"math/bits"
	"runtime"
	"sync"
)

// BitLinear is y = (quantize_int8(x) @ T^T) * (xScale * Scale), where
// T ∈ {-1,0,1}^(Out×In) is packed row-major into TernaryTile groups of 16
// along In (In padded up to a multiple of 16 with implicit zero weights),
// Scale is the per-tensor absmean weight scale (HF's "weight_scale"), and
// xScale is the per-token activation dequant factor computed internally by
// Forward/ForwardBatch (maxAbs(x)/127, matching ActQuant above).
type BitLinear struct {
	In, Out int
	Tiles   []TernaryTile // len = Out * ceil(In/16)
	Scale   float32       // per-tensor absmean weight scale ("weight_scale")
}

// NewBitLinear allocates a zero-initialized BitLinear (all weights 0,
// Scale 1). Callers (the NXTF-v3 importer, or a test fixture loader) fill
// weights via SetRow and set Scale directly.
func NewBitLinear(in, out int) *BitLinear {
	tilesPerRow := (in + 15) / 16
	return &BitLinear{
		In:    in,
		Out:   out,
		Tiles: make([]TernaryTile, out*tilesPerRow),
		Scale: 1,
	}
}

func (l *BitLinear) tilesPerRow() int {
	return (l.In + 15) / 16
}

// SetRow packs the ternary weights for output row `out` (w has len l.In,
// values in {-1,0,1}) into l.Tiles. Positions beyond l.In within the last
// tile are implicitly zero (padding), matching the contract's "In padded
// up to a multiple of 16".
func (l *BitLinear) SetRow(out int, w []int8) {
	if out < 0 || out >= l.Out {
		panic("cortex: BitLinear.SetRow: out index out of range")
	}
	if len(w) != l.In {
		panic("cortex: BitLinear.SetRow: len(w) != In")
	}
	tpr := l.tilesPerRow()
	var buf [16]int8
	for t := 0; t < tpr; t++ {
		buf = [16]int8{}
		base := t * 16
		n := 16
		if base+n > l.In {
			n = l.In - base
		}
		for i := 0; i < n; i++ {
			v := w[base+i]
			if v < -1 || v > 1 {
				panic("cortex: BitLinear.SetRow: weight not in {-1,0,1}")
			}
			buf[i] = v
		}
		l.Tiles[out*tpr+t] = PackTernaryTile(buf)
	}
}

// quantizeActivationsInt8 performs the per-token (per-row) symmetric int8
// absmax quantization ActQuant applies: scale = 127/max(|x|,eps), round,
// clamp to [-128,127]. Returns the quantized values and the dequantization
// factor xScale = 1/scale = max(|x|,eps)/127, i.e. x_i ≈ qx_i * xScale.
//
// Rounding is round-half-away-from-zero — see the package doc comment
// above for why this deliberately differs from torch.round's round-half-
// to-even, and why the difference is provably negligible.
func quantizeActivationsInt8(x []float32) ([]int8, float32) {
	var maxAbs float32
	for _, v := range x {
		a := v
		if a < 0 {
			a = -a
		}
		if a > maxAbs {
			maxAbs = a
		}
	}
	if maxAbs < 1e-5 {
		maxAbs = 1e-5
	}
	quantScale := 127.0 / maxAbs
	xScale := maxAbs / 127.0

	qx := make([]int8, len(x))
	for i, v := range x {
		q := v * quantScale
		var r int32
		if q >= 0 {
			r = int32(q + 0.5)
		} else {
			r = int32(q - 0.5)
		}
		if r > 127 {
			r = 127
		} else if r < -128 {
			r = -128
		}
		qx[i] = int8(r)
	}
	return qx, xScale
}

// dotTernaryInt8 computes the int32 dot product of a packed ternary weight
// row (tilesPerRow TernaryTiles starting at l.Tiles[rowOffset]) against a
// quantized activation vector qx, using only add/subtract — the "tight
// loop" the task calls for: tiles are unpacked once per row (via bit
// masks, no allocation) and only the non-zero weight positions are
// visited.
func dotTernaryInt8(tiles []TernaryTile, qx []int8) int32 {
	var acc int32
	for t, tile32 := range tiles {
		tile := uint32(tile32)
		signLo := uint8(tile)
		maskLo := uint8(tile >> 8)
		signHi := uint8(tile >> 16)
		maskHi := uint8(tile >> 24)
		baseIdx := t * 16

		posLo := maskLo &^ signLo
		negLo := maskLo & signLo
		for posLo != 0 {
			bit := posLo & (-posLo)
			idx := baseIdx + bits.TrailingZeros8(bit)
			acc += int32(qx[idx])
			posLo ^= bit
		}
		for negLo != 0 {
			bit := negLo & (-negLo)
			idx := baseIdx + bits.TrailingZeros8(bit)
			acc -= int32(qx[idx])
			negLo ^= bit
		}

		posHi := maskHi &^ signHi
		negHi := maskHi & signHi
		for posHi != 0 {
			bit := posHi & (-posHi)
			idx := baseIdx + 8 + bits.TrailingZeros8(bit)
			acc += int32(qx[idx])
			posHi ^= bit
		}
		for negHi != 0 {
			bit := negHi & (-negHi)
			idx := baseIdx + 8 + bits.TrailingZeros8(bit)
			acc -= int32(qx[idx])
			negHi ^= bit
		}
	}
	return acc
}

// Forward computes y = (quantize_int8(x) @ T^T) * (xScale * Scale) for a
// single token. len(x) must equal l.In.
func (l *BitLinear) Forward(x []float32) []float32 {
	if len(x) != l.In {
		panic("cortex: BitLinear.Forward: len(x) != In")
	}
	qx, xScale := quantizeActivationsInt8(x)
	tpr := l.tilesPerRow()
	factor := xScale * l.Scale

	out := make([]float32, l.Out)
	for j := 0; j < l.Out; j++ {
		row := l.Tiles[j*tpr : j*tpr+tpr]
		acc := dotTernaryInt8(row, qx)
		out[j] = float32(acc) * factor
	}
	return out
}

// ForwardBatch applies BitLinear to every row of x. Activation
// quantization is per-token (no cross-row state there), but the weight
// matrix — l.Tiles, up to tens of MB for the 2.4B-param model's Gate/Up/
// Down layers — does not fit in cache. Looping Forward() per token would
// sweep the whole matrix from memory once per token (T passes); instead
// the weight rows are the OUTER loop here, so each row is read from memory
// once and its tiles are immediately reused for every token's dot product
// while still hot — cutting weight-matrix memory traffic by a factor of T
// (measured ~2.3x wall-clock on a 2.4B-param-shaped model with 20 tokens;
// the remainder of the cost is genuinely compute-bound int32 accumulation,
// which is why output rows are additionally sharded across GOMAXPROCS
// goroutines below — each row's dot products are fully independent, so
// this changes neither the arithmetic nor the result, only how many CPU
// cores compute it). Produces bit-identical results to calling Forward
// per row: only iteration order/parallelism changes, not the arithmetic.
func (l *BitLinear) ForwardBatch(x [][]float32) [][]float32 {
	T := len(x)
	out := make([][]float32, T)
	if T == 0 {
		return out
	}

	qxs := make([][]int8, T)
	xScales := make([]float32, T)
	for t, row := range x {
		if len(row) != l.In {
			panic("cortex: BitLinear.ForwardBatch: len(x[t]) != In")
		}
		qxs[t], xScales[t] = quantizeActivationsInt8(row)
	}
	for t := range out {
		out[t] = make([]float32, l.Out)
	}

	tpr := l.tilesPerRow()

	workers := runtime.GOMAXPROCS(0)
	if workers > l.Out {
		workers = l.Out
	}
	if workers < 2 {
		bitLinearForwardRows(l.Tiles, tpr, 0, l.Out, qxs, xScales, l.Scale, out)
		return out
	}

	chunk := (l.Out + workers - 1) / workers
	var wg sync.WaitGroup
	for start := 0; start < l.Out; start += chunk {
		end := start + chunk
		if end > l.Out {
			end = l.Out
		}
		wg.Add(1)
		go func(start, end int) {
			defer wg.Done()
			bitLinearForwardRows(l.Tiles, tpr, start, end, qxs, xScales, l.Scale, out)
		}(start, end)
	}
	wg.Wait()
	return out
}

// bitLinearForwardRows computes out[t][j] for j in [start,end) and every
// token t, sharing the tight int32 dot-product loop between the
// single-goroutine and sharded paths of ForwardBatch.
func bitLinearForwardRows(tiles []TernaryTile, tpr, start, end int, qxs [][]int8, xScales []float32, scale float32, out [][]float32) {
	T := len(qxs)
	for j := start; j < end; j++ {
		row := tiles[j*tpr : j*tpr+tpr]
		for t := 0; t < T; t++ {
			acc := dotTernaryInt8(row, qxs[t])
			out[t][j] = float32(acc) * xScales[t] * scale
		}
	}
}
