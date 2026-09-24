package cortex

// bitnet_decode.go — incremental (KV-cached) decoding for BitNetModel.
//
// BitNetModel.Forward (bitnet.go) recomputes the whole sequence from
// scratch on every call: O(n^2) attention work across n decoding steps.
// BitNetDecoder instead keeps, per layer, the RoPE-applied K and every V
// projection computed so far ("the KV cache") so that appending one new
// token (Step) only re-runs the per-token projections plus attention
// against the existing cache — O(n) work for the n-th step, O(n^2) total
// across a whole generation instead of O(n^3).
//
// Cache layout: d.layerK[layer][pos] and d.layerV[layer][pos] are each a
// []float32 of length kvDim = Cfg.NumKVHeads * headDim — exactly the
// per-token K/V row bitnetAttention computes internally via
// layer.K.ForwardBatch / layer.V.ForwardBatch. K rows are stored AFTER
// RoPE (applied once, at the position the token was produced); V rows are
// stored as projected (V never gets RoPE — see bitnet.go's bitnetAttention).
// Memory per cached token: NumLayers * 2 * kvDim * 4 bytes. For the real
// microsoft/bitnet-b1.58-2B-4T checkpoint (NumLayers=30, NumKVHeads=5,
// headDim=128 -> kvDim=640): 30*2*640*4 = 153,600 bytes (~150 KiB) per
// token, ~600 MiB for a full 4096-token (Cfg.MaxSeqLen) context.
//
// Bit-for-bit equivalence with Forward. Both Prefill and Step are built
// entirely out of the SAME primitives Forward/bitnetDecoderLayer use
// (RMSNorm, BitLinear.ForwardBatch, applyRoPEHalf, ropeCosSin), applied to
// the same values in the same order:
//
//   - Prefill calls the existing, unmodified bitnetDecoderLayer/
//     bitnetAttention/bitnetMLP to produce the hidden states (so Prefill's
//     output is Forward's output, not an approximation of it); bitnetAttention
//     also returns the RoPE-applied K / (un-rotated) V it computed
//     internally on the way there, which Prefill captures into the cache
//     directly — no separate re-derivation pass.
//   - Step projects Q/K/V/O/Gate/Up/Down via BitLinear.ForwardBatch on a
//     length-1 batch (not the plain single-row Forward, which multiplies
//     xScale*Scale in a different order and so is not guaranteed bit-
//     identical) — ForwardBatch's own doc comment guarantees per-row
//     results are bit-identical to any other batch size, including the
//     batched call Prefill/Forward make. The attention loop in
//     decodeStepAttention mirrors bitnetAttention's dot-product / softmax /
//     weighted-sum loops exactly (same iteration order), and consumes
//     cached K/V rows that are themselves bit-identical to what Forward
//     would have computed at that position — so causal masking (attend
//     over s in [0,pos]) reproduces Forward's per-position logits exactly,
//     since BitNet's causal attention already guarantees position t's
//     logits depend only on tokens [0,t].
//
// RoPE tables (cos/sin, one row per absolute position) are precomputed
// once for the full [0, Cfg.MaxSeqLen) range at construction, then indexed
// by absolute position — never recomputed relative to "how many tokens
// have we seen", so Prefill and Step agree with Forward's cos[t]/sin[t]
// (also absolute-position-indexed; see ropeCosSin's doc comment) for any t.
//
// MaxSeqLen policy: Prefill panics if len(ids) > Cfg.MaxSeqLen, and Step
// panics if appending the new token would exceed Cfg.MaxSeqLen — both
// documented, deliberate hard failures (the public Prefill/Step signatures
// return only logits, so there is no error return to report overflow
// through). Callers that generate token-by-token (GenerateGreedy,
// GenerateSampled) check Decoder.Len() against Cfg.MaxSeqLen BEFORE
// calling Step and stop generation early instead, so normal generation
// never hits the panic — it exists only to catch a caller-side bug that
// tries to push the cache past what RoPE/attention were sized for.

import (
	"fmt"
	"math"
)

// BitNetDecoder is an incremental, KV-cached decoder for one BitNetModel.
// Not safe for concurrent use — a decoder holds the single growing cache
// for one in-progress sequence.
type BitNetDecoder struct {
	m *BitNetModel

	hd    int // per-head dim (Cfg.EmbedDim / Cfg.NumHeads)
	kvDim int // Cfg.NumKVHeads * hd — length of every cached K/V row

	cos, sin [][]float32 // RoPE tables, index = absolute position, len Cfg.MaxSeqLen

	layerK [][][]float32 // [layer][pos] -> RoPE-applied K row, len kvDim
	layerV [][][]float32 // [layer][pos] -> V row (no RoPE), len kvDim

	pos int // number of tokens cached so far == next absolute position

	// stepBuf holds fixed-size scratch buffers reused across every layer
	// of every Step call (lazily allocated on first Step, then kept for
	// the decoder's lifetime — see newBitNetStepBuf's doc comment). Step
	// runs once per generated token, so without reuse these would
	// otherwise be freshly allocated 30 times (once per layer) on every
	// single token. Not used by Prefill/Forward, which stay on the
	// original allocating RMSNorm/bitnetDecoderLayer path shared with
	// Forward — that path runs once per generation (not once per token),
	// so its allocation cost is far less impactful, and reusing buffers
	// there would mean threading scratch state through code Forward also
	// calls, which risks the very bit-exactness this package is built to
	// preserve for no measurable benefit.
	stepBuf *bitNetStepBuf
}

// bitNetStepBuf groups BitNetDecoder.Step's reusable per-step scratch
// buffers. Every buffer here is overwritten at the start of the layer
// iteration that uses it (or is a running accumulator explicitly reset to
// zero first — see decodeStepAttention's attnOut) before being read, so
// reuse across layers/steps changes nothing about the arithmetic; it only
// avoids repeated make([]float32, ...) calls for the same fixed sizes.
// Nothing stored here is retained past the Step call that fills it — the
// KV cache (BitNetDecoder.layerK/layerV) keeps its own freshly-allocated
// slices every time, since those must persist across future Steps.
type bitNetStepBuf struct {
	scratch []float32 // len hd — applyRoPEHalf's rotate-half scratch
	weights []float32 // len Cfg.MaxSeqLen — attention softmax weights, sliced [:pos+1]
	x       []float32 // len EmbedDim — the residual stream, overwritten each layer
	resid   []float32 // len EmbedDim — post-attention residual sum
	normed  []float32 // len EmbedDim — AttnNorm(x) / FinalNorm(x) scratch
	attnOut []float32 // len EmbedDim — running attention output accumulator
	normed2 []float32 // len EmbedDim — FFNNorm(resid)
	mlpRow  []float32 // len FFNDim — relu2(gate)*up, then FFNSubNorm(...) in place
}

func newBitNetStepBuf(cfg BitNetConfig, hd int) *bitNetStepBuf {
	return &bitNetStepBuf{
		scratch: make([]float32, hd),
		weights: make([]float32, cfg.MaxSeqLen),
		x:       make([]float32, cfg.EmbedDim),
		resid:   make([]float32, cfg.EmbedDim),
		normed:  make([]float32, cfg.EmbedDim),
		attnOut: make([]float32, cfg.EmbedDim),
		normed2: make([]float32, cfg.EmbedDim),
		mlpRow:  make([]float32, cfg.FFNDim),
	}
}

// rmsNormInto computes the same value as cortex.RMSNorm(x, weight, eps)
// (rmsnorm.go) but writes into dst instead of allocating a fresh slice —
// duplicated here (rather than changing RMSNorm's signature, which is
// outside this file's scope and shared with non-BitNet callers) purely so
// BitNetDecoder.Step's hot path can reuse fixed-size buffers instead of
// allocating 4 fresh EmbedDim/FFNDim slices per layer (120 allocations
// per generated token). dst and x may alias (safe: every element is read
// before that same index is written, exactly like RMSNorm's own
// allocate-and-fill loop). len(dst)/len(weight) must equal len(x).
func rmsNormInto(dst, x, weight []float32, eps float64) {
	var sumSq float64
	for _, v := range x {
		f := float64(v)
		sumSq += f * f
	}
	variance := sumSq / float64(len(x))
	invStd := 1.0 / math.Sqrt(variance+eps)
	for i, v := range x {
		dst[i] = weight[i] * float32(float64(v)*invStd)
	}
}

// NewBitNetDecoder builds a decoder for m with empty cache state. The RoPE
// tables are precomputed once here for the full [0, m.Cfg.MaxSeqLen) range.
func NewBitNetDecoder(m *BitNetModel) *BitNetDecoder {
	hd := m.Cfg.headDim()
	cos, sin := ropeCosSin(m.Cfg.MaxSeqLen, hd, m.Cfg.RopeTheta)
	d := &BitNetDecoder{
		m:     m,
		hd:    hd,
		kvDim: m.Cfg.NumKVHeads * hd,
		cos:   cos,
		sin:   sin,
	}
	d.Reset()
	return d
}

// Reset clears all cached state (K/V for every layer, and the position
// counter), leaving the decoder ready for a fresh Prefill.
func (d *BitNetDecoder) Reset() {
	d.layerK = make([][][]float32, len(d.m.Layers))
	d.layerV = make([][][]float32, len(d.m.Layers))
	for i := range d.layerK {
		d.layerK[i] = make([][]float32, 0, d.m.Cfg.MaxSeqLen)
		d.layerV[i] = make([][]float32, 0, d.m.Cfg.MaxSeqLen)
	}
	d.pos = 0
}

// Len returns the number of tokens currently cached (the next token's
// absolute position).
func (d *BitNetDecoder) Len() int {
	return d.pos
}

// Prefill processes a prompt as one batch, filling every layer's KV cache
// and returning the last position's logits (equal to Forward(ids)[len-1]).
// Must be called on a freshly-constructed or just-Reset decoder — calling
// it twice without an intervening Reset panics, as does a prompt longer
// than Cfg.MaxSeqLen (see file doc comment's "MaxSeqLen policy").
func (d *BitNetDecoder) Prefill(ids []int) []float32 {
	if len(ids) == 0 {
		panic("cortex: BitNetDecoder.Prefill: empty ids")
	}
	if d.pos != 0 {
		panic("cortex: BitNetDecoder.Prefill: decoder already has cached state; call Reset first")
	}
	cfg := d.m.Cfg
	T := len(ids)
	if T > cfg.MaxSeqLen {
		panic(fmt.Sprintf("cortex: BitNetDecoder.Prefill: %d prompt tokens exceeds Cfg.MaxSeqLen %d", T, cfg.MaxSeqLen))
	}

	dModel := cfg.EmbedDim
	x := make([][]float32, T)
	for t, id := range ids {
		row := make([]float32, dModel)
		copy(row, d.m.Embed[id*dModel:(id+1)*dModel])
		x[t] = row
	}

	cos := d.cos[:T]
	sin := d.sin[:T]

	for li, layer := range d.m.Layers {
		// bitnetDecoderLayer is the same unmodified code path Forward uses
		// — Prefill's hidden states are Forward's hidden states, not a
		// re-implementation of them — and now also returns the layer's
		// RoPE-applied K / (un-rotated) V projections it computed
		// internally on the way there, so they're captured into the cache
		// directly instead of re-deriving them with a second AttnNorm +
		// K.ForwardBatch/V.ForwardBatch + RoPE pass (the "double work" a
		// separate projectKV call used to do here).
		var K, V [][]float32
		x, K, V = bitnetDecoderLayer(layer, x, cos, sin, cfg)
		d.layerK[li] = append(d.layerK[li], K...)
		d.layerV[li] = append(d.layerV[li], V...)
	}

	// Only the last position's logits are ever returned, so only RMSNorm
	// that one row instead of all T (Forward, which the equivalence test
	// checks against every position of, still norms the full sequence).
	last := RMSNorm(x[T-1], d.m.FinalNorm, cfg.RMSNormEps)
	d.pos = T

	return d.lmHead(last)
}

// decodeStepAttention runs one decoder layer's attention block for a single
// new token at absolute position pos: projects Q/K/V, applies RoPE to Q/K,
// appends K/V to the layer's cache, attends over cache[0:pos+1], and
// returns O(attn_sub_norm(attn)) — see the file doc comment for why this
// reproduces bitnetAttention's per-position arithmetic exactly. scratch,
// weights and attnOut come from buf (bitNetStepBuf) instead of being
// allocated fresh on every call — see bitNetStepBuf's doc comment.
func (d *BitNetDecoder) decodeStepAttention(li int, layer *BitNetLayer, xNormed []float32, pos int, buf *bitNetStepBuf) []float32 {
	cfg := d.m.Cfg
	hd := d.hd
	nHeads := cfg.NumHeads
	nKV := cfg.NumKVHeads
	nRep := nHeads / nKV

	q := layer.Q.ForwardBatch([][]float32{xNormed})[0]
	k := layer.K.ForwardBatch([][]float32{xNormed})[0]
	v := layer.V.ForwardBatch([][]float32{xNormed})[0]

	cosT, sinT := d.cos[pos], d.sin[pos]
	scratch := buf.scratch
	for h := 0; h < nHeads; h++ {
		applyRoPEHalf(q[h*hd:(h+1)*hd], cosT, sinT, scratch)
	}
	for h := 0; h < nKV; h++ {
		applyRoPEHalf(k[h*hd:(h+1)*hd], cosT, sinT, scratch)
	}

	d.layerK[li] = append(d.layerK[li], k)
	d.layerV[li] = append(d.layerV[li], v)

	scale := float32(1.0 / math.Sqrt(float64(hd)))
	attnOut := buf.attnOut
	for i := range attnOut {
		attnOut[i] = 0 // running accumulator (out[kk] +=below) — reset each call
	}
	weights := buf.weights[:pos+1] // reused per head, like bitnetAttention's

	for h := 0; h < nHeads; h++ {
		kvh := h / nRep
		qv := q[h*hd : (h+1)*hd]

		maxScore := float32(math.Inf(-1))
		for s := 0; s <= pos; s++ {
			kv := d.layerK[li][s][kvh*hd : (kvh+1)*hd]
			var dot float32
			for kk := 0; kk < hd; kk++ {
				dot += qv[kk] * kv[kk]
			}
			dot *= scale
			weights[s] = dot
			if dot > maxScore {
				maxScore = dot
			}
		}
		var sum float32
		for s := 0; s <= pos; s++ {
			e := float32(math.Exp(float64(weights[s] - maxScore)))
			weights[s] = e
			sum += e
		}
		inv := 1 / sum

		out := attnOut[h*hd : (h+1)*hd]
		for s := 0; s <= pos; s++ {
			w := weights[s] * inv
			vv := d.layerV[li][s][kvh*hd : (kvh+1)*hd]
			for kk := 0; kk < hd; kk++ {
				out[kk] += w * vv[kk]
			}
		}
	}

	rmsNormInto(attnOut, attnOut, layer.AttnSubNorm, cfg.RMSNormEps) // in place — safe, see rmsNormInto's doc comment
	return layer.O.ForwardBatch([][]float32{attnOut})[0]
}

// decodeStepMLP mirrors bitnetMLP for a single token row. row comes from
// buf.mlpRow (bitNetStepBuf) instead of a fresh FFNDim-length allocation
// every call.
func decodeStepMLP(layer *BitNetLayer, xNormed []float32, cfg BitNetConfig, buf *bitNetStepBuf) []float32 {
	gate := layer.Gate.ForwardBatch([][]float32{xNormed})[0]
	up := layer.Up.ForwardBatch([][]float32{xNormed})[0]

	row := buf.mlpRow
	for k := 0; k < cfg.FFNDim; k++ {
		r := gate[k]
		if r < 0 {
			r = 0
		}
		row[k] = r * r * up[k]
	}
	rmsNormInto(row, row, layer.FFNSubNorm, cfg.RMSNormEps) // in place — safe, see rmsNormInto's doc comment
	return layer.Down.ForwardBatch([][]float32{row})[0]
}

// Step appends one new token to the cache and returns its logits. Prefill
// must have been called first (Step panics otherwise), and Step panics if
// the new token would push the cache past Cfg.MaxSeqLen (see file doc
// comment's "MaxSeqLen policy" — callers should check Len() first).
func (d *BitNetDecoder) Step(id int) []float32 {
	if d.pos == 0 {
		panic("cortex: BitNetDecoder.Step: no cached state; call Prefill first")
	}
	cfg := d.m.Cfg
	if d.pos >= cfg.MaxSeqLen {
		panic(fmt.Sprintf("cortex: BitNetDecoder.Step: position %d would exceed Cfg.MaxSeqLen %d", d.pos, cfg.MaxSeqLen))
	}
	pos := d.pos
	dModel := cfg.EmbedDim

	if d.stepBuf == nil {
		d.stepBuf = newBitNetStepBuf(cfg, d.hd)
	}
	buf := d.stepBuf

	// x and resid are reused across all 30 layers (see bitNetStepBuf's doc
	// comment): each layer reads x to produce resid, reads resid twice
	// (FFNNorm input, then the final residual sum), and only THEN
	// overwrites x with that sum — so by the time either buffer is
	// written, nothing later in the same iteration still needs its old
	// value, and the next iteration reads the freshly-written one.
	x := buf.x
	copy(x, d.m.Embed[id*dModel:(id+1)*dModel])
	resid := buf.resid

	for li, layer := range d.m.Layers {
		rmsNormInto(buf.normed, x, layer.AttnNorm, cfg.RMSNormEps)
		attnOut := d.decodeStepAttention(li, layer, buf.normed, pos, buf)

		for i := 0; i < dModel; i++ {
			resid[i] = x[i] + attnOut[i]
		}

		rmsNormInto(buf.normed2, resid, layer.FFNNorm, cfg.RMSNormEps)
		ffnOut := decodeStepMLP(layer, buf.normed2, cfg, buf)

		for i := 0; i < dModel; i++ {
			x[i] = resid[i] + ffnOut[i]
		}
	}

	rmsNormInto(buf.normed, x, d.m.FinalNorm, cfg.RMSNormEps)
	d.pos++
	return d.lmHead(buf.normed)
}

// lmHead projects a single [EmbedDim] hidden vector to VocabSize logits,
// reusing Forward's own row-sharded lmHeadRows so the arithmetic is
// identical to what Forward does for the last position of a batch, and
// the same shared worker pool (bitnetParallelFor, bitnet_linear.go) so the
// sharding itself is identical too.
func (d *BitNetDecoder) lmHead(x []float32) []float32 {
	cfg := d.m.Cfg
	V := cfg.VocabSize
	xs := [][]float32{x}
	logits := [][]float32{make([]float32, V)}

	bitnetParallelFor(V, func(start, end int) {
		lmHeadRows(d.m.Embed, cfg.EmbedDim, start, end, xs, logits)
	})
	return logits[0]
}
