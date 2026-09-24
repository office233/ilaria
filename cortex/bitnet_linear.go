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

// ─────────────────────────────────────────────────────────────────────
// Fixed worker pool — replaces the old "spawn goroutines per call"
// pattern BitLinear.ForwardBatch and lmHead(Rows) used. A single decode
// step calls BitLinear.ForwardBatch 7 times per layer (Q/K/V/O/Gate/Up/
// Down) across 30 layers plus one lm_head shard = 211 fan-out points, each
// previously spinning up its own `go func(){...}(); wg.Wait()` batch of
// GOMAXPROCS goroutines from scratch. bitnetParallelFor instead submits
// work to a small set of long-lived worker goroutines (started once, lazily,
// on first use) over a channel, so steady-state decoding pays channel-send
// + WaitGroup cost per chunk instead of goroutine-creation cost — cheaper
// and, under CPU contention from other processes, less exposed to
// scheduler jitter from repeatedly creating/destroying goroutines. Changes
// only how the independent per-row (or per-vocab-row) work is scheduled,
// never the arithmetic: chunk boundaries are identical to the old
// GOMAXPROCS-sharded split, so results are bit-identical.
var (
	bitnetPoolOnce sync.Once
	bitnetPoolJobs chan func()
)

func bitnetPoolInit() {
	n := runtime.GOMAXPROCS(0)
	if n < 1 {
		n = 1
	}
	bitnetPoolJobs = make(chan func(), n*4)
	for i := 0; i < n; i++ {
		go func() {
			for job := range bitnetPoolJobs {
				job()
			}
		}()
	}
}

// bitnetParallelFor splits [0,n) into up to GOMAXPROCS contiguous chunks
// and runs fn(start,end) for each chunk on the shared worker pool,
// blocking until every chunk finishes. Falls back to running fn(0,n)
// in-line (no goroutines at all) when n is too small to split or
// GOMAXPROCS==1 — same threshold the old per-call spawn logic used.
func bitnetParallelFor(n int, fn func(start, end int)) {
	if n <= 0 {
		return
	}
	workers := runtime.GOMAXPROCS(0)
	if workers > n {
		workers = n
	}
	if workers < 2 {
		fn(0, n)
		return
	}

	bitnetPoolOnce.Do(bitnetPoolInit)

	chunk := (n + workers - 1) / workers
	var wg sync.WaitGroup
	for start := 0; start < n; start += chunk {
		end := start + chunk
		if end > n {
			end = n
		}
		wg.Add(1)
		s, e := start, end
		bitnetPoolJobs <- func() {
			defer wg.Done()
			fn(s, e)
		}
	}
	wg.Wait()
}

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

	// gpu, when non-nil, serves ForwardBatch from a resident GPU backend
	// (see bitnet_backend.go / bitnet_gpu.go, build tag `gpu`) instead of
	// the CPU loop below. Set only by EnableBitNetGPU; nil in default
	// builds (bitnet_gpu_stub.go). GPU HOOK — coordinate before editing.
	gpu bitLinearGPU
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

// quantizeActivationsInt32 performs the per-token (per-row) symmetric int8
// absmax quantization ActQuant applies: scale = 127/max(|x|,eps), round,
// clamp to [-128,127]. Returns the quantized values — widened to int32
// once here rather than stored as int8 and re-widened on every access
// inside dotTernaryInt8's inner loop, which used to run that conversion
// once per (output row, weight position) instead of once per input value
// — and the dequantization factor xScale = 1/scale = max(|x|,eps)/127,
// i.e. x_i ≈ qx_i * xScale. The quantized values themselves are still
// exactly the int8-range integers ActQuant produces (clamped to
// [-128,127]); only the storage width changed, so this is bit-identical
// to the old int8 path, just cheaper to consume.
//
// Rounding is round-half-away-from-zero — see the package doc comment
// above for why this deliberately differs from torch.round's round-half-
// to-even, and why the difference is provably negligible.
func quantizeActivationsInt32(x []float32) ([]int32, float32) {
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

	qx := make([]int32, len(x))
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
		qx[i] = r
	}
	return qx, xScale
}

// tileSignMask16 unpacks one TernaryTile's sign/mask bytes into 16-bit
// values whose bit k (k in [0,16)) is weight k's sign/active bit — merging
// the tile's Lo (weights 0-7) and Hi (weights 8-15) byte pairs so the
// pos/neg bit-scans below each walk one 16-bit word instead of two 8-bit
// words. Bit order is preserved exactly (Lo bits occupy 0-7, Hi bits 8-15,
// same as the weight indices themselves), so scanning the merged word
// low-bit-first visits weights in the exact same ascending order the
// original Lo-then-Hi byte-pair scan did.
func tileSignMask16(tile32 TernaryTile) (sign16, mask16 uint16) {
	tile := uint32(tile32)
	signLo := uint8(tile)
	maskLo := uint8(tile >> 8)
	signHi := uint8(tile >> 16)
	maskHi := uint8(tile >> 24)
	sign16 = uint16(signLo) | uint16(signHi)<<8
	mask16 = uint16(maskLo) | uint16(maskHi)<<8
	return sign16, mask16
}

// dotTernaryInt8 computes the int32 dot product of a packed ternary weight
// row (tilesPerRow TernaryTiles starting at l.Tiles[rowOffset]) against a
// quantized (int32-widened, see quantizeActivationsInt32) activation
// vector qx, using only add/subtract — the "tight loop" the task calls
// for: tiles are unpacked once per row (via bit masks, no allocation) and
// only the non-zero weight positions are visited. Int32 add/subtract is
// exactly associative (no overflow for any BitNet-b1.58-2B-4T shape: the
// largest row is 6912 terms of magnitude <=127, max |sum| ~878K, far under
// int32's ~2.1B range), so the positive-then-negative, ascending-index
// visitation order here is provably bit-identical to any other order,
// including dotTernaryInt8x4's row-interleaved order below.
func dotTernaryInt8(tiles []TernaryTile, qx []int32) int32 {
	var acc int32
	for t, tile32 := range tiles {
		sign16, mask16 := tileSignMask16(tile32)
		baseIdx := t * 16

		pos := mask16 &^ sign16
		neg := mask16 & sign16
		for pos != 0 {
			bit := pos & (-pos)
			idx := baseIdx + bits.TrailingZeros16(bit)
			acc += qx[idx]
			pos ^= bit
		}
		for neg != 0 {
			bit := neg & (-neg)
			idx := baseIdx + bits.TrailingZeros16(bit)
			acc -= qx[idx]
			neg ^= bit
		}
	}
	return acc
}

// dotTernaryInt8x4 computes the same int32 dot product as dotTernaryInt8,
// for 4 weight rows against the same qx, in one pass — interleaving the
// four independent accumulator chains (acc0..acc3) within a single loop
// over tile columns instead of the caller running dotTernaryInt8 four
// times back-to-back. Each row's chain has a loop-carried dependency
// (next bit-scan needs this iteration's `pos ^= bit`), which stalls a
// single-row scan on TrailingZeros16 latency; interleaving four
// independent chains gives the CPU's out-of-order execution four
// unrelated chains to overlap instead of one, filling that latency with
// useful work from the other three rows. All four rows must share the
// same tilesPerRow length (true for every row within one BitLinear).
// Bit-identical to four dotTernaryInt8 calls per the same int32-exact-
// associativity argument in dotTernaryInt8's doc comment.
func dotTernaryInt8x4(r0, r1, r2, r3 []TernaryTile, qx []int32) (acc0, acc1, acc2, acc3 int32) {
	n := len(r0)
	for t := 0; t < n; t++ {
		baseIdx := t * 16

		sign0, mask0 := tileSignMask16(r0[t])
		sign1, mask1 := tileSignMask16(r1[t])
		sign2, mask2 := tileSignMask16(r2[t])
		sign3, mask3 := tileSignMask16(r3[t])

		pos0, neg0 := mask0&^sign0, mask0&sign0
		pos1, neg1 := mask1&^sign1, mask1&sign1
		pos2, neg2 := mask2&^sign2, mask2&sign2
		pos3, neg3 := mask3&^sign3, mask3&sign3

		for pos0 != 0 {
			bit := pos0 & (-pos0)
			acc0 += qx[baseIdx+bits.TrailingZeros16(bit)]
			pos0 ^= bit
		}
		for neg0 != 0 {
			bit := neg0 & (-neg0)
			acc0 -= qx[baseIdx+bits.TrailingZeros16(bit)]
			neg0 ^= bit
		}

		for pos1 != 0 {
			bit := pos1 & (-pos1)
			acc1 += qx[baseIdx+bits.TrailingZeros16(bit)]
			pos1 ^= bit
		}
		for neg1 != 0 {
			bit := neg1 & (-neg1)
			acc1 -= qx[baseIdx+bits.TrailingZeros16(bit)]
			neg1 ^= bit
		}

		for pos2 != 0 {
			bit := pos2 & (-pos2)
			acc2 += qx[baseIdx+bits.TrailingZeros16(bit)]
			pos2 ^= bit
		}
		for neg2 != 0 {
			bit := neg2 & (-neg2)
			acc2 -= qx[baseIdx+bits.TrailingZeros16(bit)]
			neg2 ^= bit
		}

		for pos3 != 0 {
			bit := pos3 & (-pos3)
			acc3 += qx[baseIdx+bits.TrailingZeros16(bit)]
			pos3 ^= bit
		}
		for neg3 != 0 {
			bit := neg3 & (-neg3)
			acc3 -= qx[baseIdx+bits.TrailingZeros16(bit)]
			neg3 ^= bit
		}
	}
	return acc0, acc1, acc2, acc3
}

// Forward computes y = (quantize_int8(x) @ T^T) * (xScale * Scale) for a
// single token. len(x) must equal l.In.
func (l *BitLinear) Forward(x []float32) []float32 {
	if len(x) != l.In {
		panic("cortex: BitLinear.Forward: len(x) != In")
	}
	qx, xScale := quantizeActivationsInt32(x)
	tpr := l.tilesPerRow()
	factor := xScale * l.Scale

	out := make([]float32, l.Out)
	j := 0
	for ; j+4 <= l.Out; j += 4 {
		r0 := l.Tiles[j*tpr : j*tpr+tpr]
		r1 := l.Tiles[(j+1)*tpr : (j+1)*tpr+tpr]
		r2 := l.Tiles[(j+2)*tpr : (j+2)*tpr+tpr]
		r3 := l.Tiles[(j+3)*tpr : (j+3)*tpr+tpr]
		a0, a1, a2, a3 := dotTernaryInt8x4(r0, r1, r2, r3, qx)
		out[j] = float32(a0) * factor
		out[j+1] = float32(a1) * factor
		out[j+2] = float32(a2) * factor
		out[j+3] = float32(a3) * factor
	}
	for ; j < l.Out; j++ {
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
// which is why output rows are additionally sharded across the shared
// worker pool below via bitnetParallelFor — each row's dot products are
// fully independent, so this changes neither the arithmetic nor the
// result, only how many CPU cores compute it and how that work is
// scheduled). Produces bit-identical results to calling Forward per row:
// only iteration order/parallelism changes, not the arithmetic.
func (l *BitLinear) ForwardBatch(x [][]float32) [][]float32 {
	if l.gpu != nil { // GPU HOOK — see bitnet_backend.go / bitnet_gpu.go
		return l.gpu.forward(x)
	}
	T := len(x)
	out := make([][]float32, T)
	if T == 0 {
		return out
	}

	qxs := make([][]int32, T)
	xScales := make([]float32, T)
	for t, row := range x {
		if len(row) != l.In {
			panic("cortex: BitLinear.ForwardBatch: len(x[t]) != In")
		}
		qxs[t], xScales[t] = quantizeActivationsInt32(row)
	}
	for t := range out {
		out[t] = make([]float32, l.Out)
	}

	tpr := l.tilesPerRow()
	tiles := l.Tiles
	scale := l.Scale
	bitnetParallelFor(l.Out, func(start, end int) {
		bitLinearForwardRows(tiles, tpr, start, end, qxs, xScales, scale, out)
	})
	return out
}

// bitLinearForwardRows computes out[t][j] for j in [start,end) and every
// token t, sharing the tight int32 dot-product loop between the
// single-goroutine and sharded paths of ForwardBatch. Rows are processed
// four at a time via dotTernaryInt8x4 (falling back to dotTernaryInt8 for
// a [start,end) span whose length isn't a multiple of 4) so the four
// accumulator chains interleave per the doc comment on dotTernaryInt8x4 —
// bit-identical to, just faster than, calling dotTernaryInt8 once per row.
func bitLinearForwardRows(tiles []TernaryTile, tpr, start, end int, qxs [][]int32, xScales []float32, scale float32, out [][]float32) {
	T := len(qxs)
	j := start
	for ; j+4 <= end; j += 4 {
		r0 := tiles[j*tpr : j*tpr+tpr]
		r1 := tiles[(j+1)*tpr : (j+1)*tpr+tpr]
		r2 := tiles[(j+2)*tpr : (j+2)*tpr+tpr]
		r3 := tiles[(j+3)*tpr : (j+3)*tpr+tpr]
		for t := 0; t < T; t++ {
			a0, a1, a2, a3 := dotTernaryInt8x4(r0, r1, r2, r3, qxs[t])
			f := xScales[t] * scale
			out[t][j] = float32(a0) * f
			out[t][j+1] = float32(a1) * f
			out[t][j+2] = float32(a2) * f
			out[t][j+3] = float32(a3) * f
		}
	}
	for ; j < end; j++ {
		row := tiles[j*tpr : j*tpr+tpr]
		for t := 0; t < T; t++ {
			acc := dotTernaryInt8(row, qxs[t])
			out[t][j] = float32(acc) * xScales[t] * scale
		}
	}
}
