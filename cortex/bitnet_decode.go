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
//     output is Forward's output, not an approximation of it), and
//     separately re-derives each layer's K/V via projectKV — the identical
//     RMSNorm + ForwardBatch + applyRoPEHalf calls bitnetAttention performs
//     internally — purely to capture them into the cache.
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
	"runtime"
	"sync"
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

// projectKV computes the RoPE-applied K and (un-rotated) V projections for
// one layer's AttnNorm-normalized input rows — exactly the computation
// bitnetAttention performs internally on its way to producing attention
// output, extracted here so Prefill can capture what bitnetAttention would
// otherwise keep local. Because this calls the identical functions
// (BitLinear.ForwardBatch, applyRoPEHalf) on the identical inputs
// bitnetAttention would use, the results are bit-for-bit what
// bitnetAttention computed internally, not merely numerically close.
func projectKV(layer *BitNetLayer, xNormed [][]float32, cos, sin [][]float32, hd, nKV int) (K, V [][]float32) {
	K = layer.K.ForwardBatch(xNormed)
	V = layer.V.ForwardBatch(xNormed)
	scratch := make([]float32, hd)
	for t := range K {
		for h := 0; h < nKV; h++ {
			applyRoPEHalf(K[t][h*hd:(h+1)*hd], cos[t], sin[t], scratch)
		}
	}
	return K, V
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
		normed := make([][]float32, T)
		for t := range x {
			normed[t] = RMSNorm(x[t], layer.AttnNorm, cfg.RMSNormEps)
		}
		K, V := projectKV(layer, normed, cos, sin, d.hd, cfg.NumKVHeads)
		d.layerK[li] = append(d.layerK[li], K...)
		d.layerV[li] = append(d.layerV[li], V...)

		// Unmodified existing batched code path — Prefill's hidden states
		// are Forward's hidden states, not a re-implementation of them.
		x = bitnetDecoderLayer(layer, x, cos, sin, cfg)
	}

	for t := range x {
		x[t] = RMSNorm(x[t], d.m.FinalNorm, cfg.RMSNormEps)
	}
	d.pos = T

	return d.lmHead(x[T-1])
}

// decodeStepAttention runs one decoder layer's attention block for a single
// new token at absolute position pos: projects Q/K/V, applies RoPE to Q/K,
// appends K/V to the layer's cache, attends over cache[0:pos+1], and
// returns O(attn_sub_norm(attn)) — see the file doc comment for why this
// reproduces bitnetAttention's per-position arithmetic exactly.
func (d *BitNetDecoder) decodeStepAttention(li int, layer *BitNetLayer, xNormed []float32, pos int) []float32 {
	cfg := d.m.Cfg
	hd := d.hd
	nHeads := cfg.NumHeads
	nKV := cfg.NumKVHeads
	nRep := nHeads / nKV

	q := layer.Q.ForwardBatch([][]float32{xNormed})[0]
	k := layer.K.ForwardBatch([][]float32{xNormed})[0]
	v := layer.V.ForwardBatch([][]float32{xNormed})[0]

	cosT, sinT := d.cos[pos], d.sin[pos]
	scratch := make([]float32, hd)
	for h := 0; h < nHeads; h++ {
		applyRoPEHalf(q[h*hd:(h+1)*hd], cosT, sinT, scratch)
	}
	for h := 0; h < nKV; h++ {
		applyRoPEHalf(k[h*hd:(h+1)*hd], cosT, sinT, scratch)
	}

	d.layerK[li] = append(d.layerK[li], k)
	d.layerV[li] = append(d.layerV[li], v)

	scale := float32(1.0 / math.Sqrt(float64(hd)))
	attnOut := make([]float32, cfg.EmbedDim)
	weights := make([]float32, pos+1) // reused per head, like bitnetAttention's

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

	attnOut = RMSNorm(attnOut, layer.AttnSubNorm, cfg.RMSNormEps)
	return layer.O.ForwardBatch([][]float32{attnOut})[0]
}

// decodeStepMLP mirrors bitnetMLP for a single token row.
func decodeStepMLP(layer *BitNetLayer, xNormed []float32, cfg BitNetConfig) []float32 {
	gate := layer.Gate.ForwardBatch([][]float32{xNormed})[0]
	up := layer.Up.ForwardBatch([][]float32{xNormed})[0]

	row := make([]float32, cfg.FFNDim)
	for k := 0; k < cfg.FFNDim; k++ {
		r := gate[k]
		if r < 0 {
			r = 0
		}
		row[k] = r * r * up[k]
	}
	row = RMSNorm(row, layer.FFNSubNorm, cfg.RMSNormEps)
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

	x := make([]float32, dModel)
	copy(x, d.m.Embed[id*dModel:(id+1)*dModel])

	for li, layer := range d.m.Layers {
		normed := RMSNorm(x, layer.AttnNorm, cfg.RMSNormEps)
		attnOut := d.decodeStepAttention(li, layer, normed, pos)

		resid1 := make([]float32, dModel)
		for i := range resid1 {
			resid1[i] = x[i] + attnOut[i]
		}

		normed2 := RMSNorm(resid1, layer.FFNNorm, cfg.RMSNormEps)
		ffnOut := decodeStepMLP(layer, normed2, cfg)

		out := make([]float32, dModel)
		for i := range out {
			out[i] = resid1[i] + ffnOut[i]
		}
		x = out
	}

	x = RMSNorm(x, d.m.FinalNorm, cfg.RMSNormEps)
	d.pos++
	return d.lmHead(x)
}

// lmHead projects a single [EmbedDim] hidden vector to VocabSize logits,
// reusing Forward's own row-sharded lmHeadRows so the arithmetic (and its
// GOMAXPROCS-sharded parallelism) is identical to what Forward does for
// the last position of a batch.
func (d *BitNetDecoder) lmHead(x []float32) []float32 {
	cfg := d.m.Cfg
	V := cfg.VocabSize
	xs := [][]float32{x}
	logits := [][]float32{make([]float32, V)}

	workers := runtime.GOMAXPROCS(0)
	if workers > V {
		workers = V
	}
	if workers < 2 {
		lmHeadRows(d.m.Embed, cfg.EmbedDim, 0, V, xs, logits)
		return logits[0]
	}

	chunk := (V + workers - 1) / workers
	var wg sync.WaitGroup
	for start := 0; start < V; start += chunk {
		end := start + chunk
		if end > V {
			end = V
		}
		wg.Add(1)
		go func(start, end int) {
			defer wg.Done()
			lmHeadRows(d.m.Embed, cfg.EmbedDim, start, end, xs, logits)
		}(start, end)
	}
	wg.Wait()
	return logits[0]
}
