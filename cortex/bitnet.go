package cortex

// bitnet.go — Microsoft BitNet b1.58 2B4T model + forward pass, for
// INFERENCE only (no training). Ground truth is the installed
// `transformers` source (transformers/models/bitnet/modeling_bitnet.py and
// transformers/integrations/bitnet.py — see bitnet_linear.go's doc comment
// for the BitLinear/AutoBitLinear specifics).
//
// Architecture, mirroring BitNetDecoderLayer.forward (modeling_bitnet.py:
// 235-266) and BitNetAttention.forward (:179-221):
//
//	residual = x
//	x = RMSNorm(x, AttnNorm)                          # input_layernorm
//	q,k,v = Q(x), K(x), V(x)                           # BitLinear
//	q,k = RoPE(q), RoPE(k)                              # Llama half-rotate
//	attn = CausalSoftmaxAttention(q,k,v, GQA)
//	attn = RMSNorm(attn, AttnSubNorm)                   # attn_sub_norm — BEFORE O
//	x = residual + O(attn)                              # BitLinear
//	residual = x
//	x = RMSNorm(x, FFNNorm)                             # post_attention_layernorm
//	h = ReLU2(Gate(x)) * Up(x)                          # BitLinear, relu2 = relu(.)^2
//	h = RMSNorm(h, FFNSubNorm)                          # ffn_sub_norm — BEFORE Down
//	x = residual + Down(h)                              # BitLinear
//
// Final: x = RMSNorm(x, FinalNorm); logits = x @ Embed^T (tied lm_head —
// BitNetForCausalLM never wraps lm_head in a BitLinear).
//
// RoPE variant: BitNet uses the Llama/"half-rotate" convention, NOT the
// interleaved convention cortex/transformer.go's applyRoPE uses for
// Ilaria — confirmed by reading rotate_half/apply_rotary_pos_emb in
// modeling_bitnet.py:81-111 (x split into two contiguous halves, cos/sin
// built as concat(freqs,freqs), not interleaved pairs). A fresh
// implementation lives in this file (ropeCosSin/applyRoPEHalf) rather than
// reusing transformer.go's applyRoPE, which is only correct for the
// interleaved layout.
//
// GQA grouping: repeat_kv (modeling_bitnet.py:114-123) repeats each KV
// head contiguously n_rep times, so query head h reads KV head h/n_rep —
// NOT h%numKVHeads.

import (
	"math"
	"math/rand"
	"runtime"
	"sync"
)

// BitNetConfig holds the hyperparameters needed to build and run a BitNet
// b1.58 model. Field values for the real checkpoint come from
// data/pretrained/bitnet-b1.58-2B-4T/config.json.
type BitNetConfig struct {
	VocabSize  int
	EmbedDim   int
	NumLayers  int
	NumHeads   int
	NumKVHeads int
	FFNDim     int
	MaxSeqLen  int

	RopeTheta  float64 // 500000 for 2B4T
	RMSNormEps float64 // 1e-5

	EOSTokenID int
	BOSTokenID int
}

// BitLinear multiplies HeadDim (see NewBitNetModel) into Q/K/V/O and
// Gate/Up/Down dimensions; BitNetLayer holds one decoder layer's weights.
type BitNetLayer struct {
	AttnNorm []float32 // input_layernorm RMSNorm weight, len EmbedDim
	FFNNorm  []float32 // post_attention_layernorm RMSNorm weight, len EmbedDim

	AttnSubNorm []float32 // attn_sub_norm, len EmbedDim — applied to attn output BEFORE O
	FFNSubNorm  []float32 // ffn_sub_norm, len FFNDim — applied BEFORE Down

	Q, K, V, O     *BitLinear
	Gate, Up, Down *BitLinear
}

// BitNetModel is the full model: tied token embedding / lm_head, decoder
// layers, and a final RMSNorm.
type BitNetModel struct {
	Cfg       BitNetConfig
	Embed     []float32 // [VocabSize*EmbedDim] row-major, tied with lm_head
	Layers    []*BitNetLayer
	FinalNorm []float32 // len EmbedDim
}

// headDim returns EmbedDim/NumHeads, the per-head dimension shared by Q, K
// and V (BitNetAttention.head_dim, modeling_bitnet.py:159).
func (cfg BitNetConfig) headDim() int {
	return cfg.EmbedDim / cfg.NumHeads
}

func onesVector(n int) []float32 {
	v := make([]float32, n)
	for i := range v {
		v[i] = 1
	}
	return v
}

// NewBitNetModel allocates a full model: token embedding, NumLayers decoder
// layers (each with zero-initialized ternary BitLinears and unit RMSNorm
// weights), and a final norm. Callers (the NXTF-v3 importer, or a test
// fixture loader) fill in Embed, the norm weights, and each BitLinear's
// Tiles/Scale via BitLinear.SetRow.
func NewBitNetModel(cfg BitNetConfig) *BitNetModel {
	hd := cfg.headDim()
	kvDim := cfg.NumKVHeads * hd

	layers := make([]*BitNetLayer, cfg.NumLayers)
	for i := range layers {
		layers[i] = &BitNetLayer{
			AttnNorm:    onesVector(cfg.EmbedDim),
			FFNNorm:     onesVector(cfg.EmbedDim),
			AttnSubNorm: onesVector(cfg.EmbedDim),
			FFNSubNorm:  onesVector(cfg.FFNDim),
			Q:           NewBitLinear(cfg.EmbedDim, cfg.EmbedDim),
			K:           NewBitLinear(cfg.EmbedDim, kvDim),
			V:           NewBitLinear(cfg.EmbedDim, kvDim),
			O:           NewBitLinear(cfg.EmbedDim, cfg.EmbedDim),
			Gate:        NewBitLinear(cfg.EmbedDim, cfg.FFNDim),
			Up:          NewBitLinear(cfg.EmbedDim, cfg.FFNDim),
			Down:        NewBitLinear(cfg.FFNDim, cfg.EmbedDim),
		}
	}

	return &BitNetModel{
		Cfg:       cfg,
		Embed:     make([]float32, cfg.VocabSize*cfg.EmbedDim),
		Layers:    layers,
		FinalNorm: onesVector(cfg.EmbedDim),
	}
}

// ─────────────────────────────────────────────────────────────────────
// RoPE — Llama/half-rotate convention (see file doc comment)
// ─────────────────────────────────────────────────────────────────────

// ropeCosSin precomputes cos/sin tables for positions [0,seqLen), each row
// length headDim, matching BitNetRotaryEmbedding.forward
// (modeling_bitnet.py:288-331): inv_freq[i] = theta^(-2i/headDim) for
// i in [0,headDim/2), freqs = position*inv_freq, emb = concat(freqs,freqs).
func ropeCosSin(seqLen, headDim int, theta float64) (cos, sin [][]float32) {
	half := headDim / 2
	invFreq := make([]float64, half)
	for i := 0; i < half; i++ {
		invFreq[i] = 1.0 / math.Pow(theta, float64(2*i)/float64(headDim))
	}
	cos = make([][]float32, seqLen)
	sin = make([][]float32, seqLen)
	for t := 0; t < seqLen; t++ {
		c := make([]float32, headDim)
		s := make([]float32, headDim)
		for i := 0; i < half; i++ {
			angle := float64(t) * invFreq[i]
			cv := float32(math.Cos(angle))
			sv := float32(math.Sin(angle))
			c[i], c[i+half] = cv, cv
			s[i], s[i+half] = sv, sv
		}
		cos[t], sin[t] = c, s
	}
	return cos, sin
}

// applyRoPEHalf rotates a single head's vector x (len headDim) in place:
//
//	rotate_half(x) = concat(-x[half:], x[:half])
//	x_embed = x*cos + rotate_half(x)*sin
//
// matching apply_rotary_pos_emb (modeling_bitnet.py:81-111) — the Llama
// half-rotate convention, NOT transformer.go's interleaved applyRoPE.
func applyRoPEHalf(x, cos, sin []float32, scratch []float32) {
	n := len(x)
	half := n / 2
	for i := 0; i < half; i++ {
		scratch[i] = -x[i+half]
		scratch[i+half] = x[i]
	}
	for i := 0; i < n; i++ {
		x[i] = x[i]*cos[i] + scratch[i]*sin[i]
	}
}

// ─────────────────────────────────────────────────────────────────────
// Attention (GQA, causal, eager softmax)
// ─────────────────────────────────────────────────────────────────────

// bitnetAttention runs self-attention for one decoder layer over the whole
// (already AttnNorm-normalized) sequence, causal, with grouped-query
// attention: query head h reads KV head h/(NumHeads/NumKVHeads) — see
// repeat_kv, modeling_bitnet.py:114-123. Returns O(attn_sub_norm(attn)).
func bitnetAttention(layer *BitNetLayer, xNormed [][]float32, cos, sin [][]float32, cfg BitNetConfig) [][]float32 {
	T := len(xNormed)
	d := cfg.EmbedDim
	hd := cfg.headDim()
	nHeads := cfg.NumHeads
	nKV := cfg.NumKVHeads
	nRep := nHeads / nKV

	Q := layer.Q.ForwardBatch(xNormed) // T x d
	K := layer.K.ForwardBatch(xNormed) // T x (nKV*hd)
	V := layer.V.ForwardBatch(xNormed) // T x (nKV*hd)

	scratch := make([]float32, hd)
	for t := 0; t < T; t++ {
		for h := 0; h < nHeads; h++ {
			applyRoPEHalf(Q[t][h*hd:(h+1)*hd], cos[t], sin[t], scratch)
		}
		for h := 0; h < nKV; h++ {
			applyRoPEHalf(K[t][h*hd:(h+1)*hd], cos[t], sin[t], scratch)
		}
	}

	scale := float32(1.0 / math.Sqrt(float64(hd)))
	attnOut := make([][]float32, T)
	for t := range attnOut {
		attnOut[t] = make([]float32, d)
	}

	weights := make([]float32, T) // reused per (head, query position)
	for h := 0; h < nHeads; h++ {
		kvh := h / nRep
		for t := 0; t < T; t++ {
			qv := Q[t][h*hd : (h+1)*hd]

			maxScore := float32(math.Inf(-1))
			for s := 0; s <= t; s++ {
				kv := K[s][kvh*hd : (kvh+1)*hd]
				var dot float32
				for k := 0; k < hd; k++ {
					dot += qv[k] * kv[k]
				}
				dot *= scale
				weights[s] = dot
				if dot > maxScore {
					maxScore = dot
				}
			}
			var sum float32
			for s := 0; s <= t; s++ {
				e := float32(math.Exp(float64(weights[s] - maxScore)))
				weights[s] = e
				sum += e
			}
			inv := 1 / sum

			out := attnOut[t][h*hd : (h+1)*hd]
			for s := 0; s <= t; s++ {
				w := weights[s] * inv
				vv := V[s][kvh*hd : (kvh+1)*hd]
				for k := 0; k < hd; k++ {
					out[k] += w * vv[k]
				}
			}
		}
	}

	for t := range attnOut {
		attnOut[t] = RMSNorm(attnOut[t], layer.AttnSubNorm, cfg.RMSNormEps)
	}
	return layer.O.ForwardBatch(attnOut)
}

// ─────────────────────────────────────────────────────────────────────
// FFN — Gate/Up/Down with ReLU² and subln
// ─────────────────────────────────────────────────────────────────────

// bitnetMLP computes Down(ffn_sub_norm(relu2(Gate(x)) * Up(x))), matching
// BitNetMLP.forward (modeling_bitnet.py:76-78) with hidden_act="relu2"
// (ReLUSquaredActivation: relu(x)^2 — transformers/activations.py:206-214).
func bitnetMLP(layer *BitNetLayer, x [][]float32, cfg BitNetConfig) [][]float32 {
	gate := layer.Gate.ForwardBatch(x) // T x FFNDim
	up := layer.Up.ForwardBatch(x)     // T x FFNDim

	T := len(x)
	prod := make([][]float32, T)
	for t := 0; t < T; t++ {
		row := make([]float32, cfg.FFNDim)
		g := gate[t]
		u := up[t]
		for k := 0; k < cfg.FFNDim; k++ {
			r := g[k]
			if r < 0 {
				r = 0
			}
			row[k] = r * r * u[k]
		}
		prod[t] = RMSNorm(row, layer.FFNSubNorm, cfg.RMSNormEps)
	}
	return layer.Down.ForwardBatch(prod)
}

// bitnetDecoderLayer runs one full pre-norm decoder layer (attention block
// + FFN block, each with its own residual), matching
// BitNetDecoderLayer.forward (modeling_bitnet.py:235-266).
func bitnetDecoderLayer(layer *BitNetLayer, x [][]float32, cos, sin [][]float32, cfg BitNetConfig) [][]float32 {
	T := len(x)
	d := cfg.EmbedDim

	normed := make([][]float32, T)
	for t := range x {
		normed[t] = RMSNorm(x[t], layer.AttnNorm, cfg.RMSNormEps)
	}
	attnOut := bitnetAttention(layer, normed, cos, sin, cfg)

	resid1 := make([][]float32, T)
	for t := range x {
		row := make([]float32, d)
		for k := 0; k < d; k++ {
			row[k] = x[t][k] + attnOut[t][k]
		}
		resid1[t] = row
	}

	normed2 := make([][]float32, T)
	for t := range resid1 {
		normed2[t] = RMSNorm(resid1[t], layer.FFNNorm, cfg.RMSNormEps)
	}
	ffnOut := bitnetMLP(layer, normed2, cfg)

	out := make([][]float32, T)
	for t := range resid1 {
		row := make([]float32, d)
		for k := 0; k < d; k++ {
			row[k] = resid1[t][k] + ffnOut[t][k]
		}
		out[t] = row
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// Full model forward / generation
// ─────────────────────────────────────────────────────────────────────

// Forward runs the full model over the given token ids and returns
// len(ids) x VocabSize float32 logits (causal — position t's logits only
// depend on ids[0:t+1]).
func (m *BitNetModel) Forward(ids []int) [][]float32 {
	T := len(ids)
	d := m.Cfg.EmbedDim

	x := make([][]float32, T)
	for t, id := range ids {
		row := make([]float32, d)
		copy(row, m.Embed[id*d:(id+1)*d])
		x[t] = row
	}

	hd := m.Cfg.headDim()
	cos, sin := ropeCosSin(T, hd, m.Cfg.RopeTheta)

	for _, layer := range m.Layers {
		x = bitnetDecoderLayer(layer, x, cos, sin, m.Cfg)
	}

	for t := range x {
		x[t] = RMSNorm(x[t], m.FinalNorm, m.Cfg.RMSNormEps)
	}

	// Tied lm_head: logits[t][v] = x[t] . Embed[v] (no BitLinear here —
	// BitNetForCausalLM never quantizes lm_head). Embed is VocabSize x
	// EmbedDim — up to ~1.3GB for the real 2.4B-param model, far past any
	// cache — so the loop is v-outer/t-inner: each Embed row is read from
	// memory once and dotted against every token immediately, instead of
	// sweeping the whole table once per token (same cache-blocking fix as
	// BitLinear.ForwardBatch), and rows are additionally sharded across
	// GOMAXPROCS goroutines (each v is independent, so this changes
	// neither the arithmetic nor the result).
	V := m.Cfg.VocabSize
	logits := make([][]float32, T)
	for t := range logits {
		logits[t] = make([]float32, V)
	}

	workers := runtime.GOMAXPROCS(0)
	if workers > V {
		workers = V
	}
	if workers < 2 {
		lmHeadRows(m.Embed, d, 0, V, x, logits)
	} else {
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
				lmHeadRows(m.Embed, d, start, end, x, logits)
			}(start, end)
		}
		wg.Wait()
	}
	return logits
}

// lmHeadRows computes logits[t][v] = x[t] . Embed[v] for v in [start,end)
// and every token t, sharing the loop body between the single-goroutine
// and sharded paths of Forward.
func lmHeadRows(embed []float32, d, start, end int, x [][]float32, logits [][]float32) {
	T := len(x)
	for v := start; v < end; v++ {
		base := v * d
		embedRow := embed[base : base+d]
		for t := 0; t < T; t++ {
			xt := x[t]
			var sum float32
			for k := 0; k < d; k++ {
				sum += xt[k] * embedRow[k]
			}
			logits[t][v] = sum
		}
	}
}

// argmaxFloat32 returns the index of the largest value in row, breaking
// ties toward the earliest (lowest) index — matching the tie-break every
// argmax loop in this package already used before this helper existed.
func argmaxFloat32(row []float32) int {
	best, bestVal := 0, row[0]
	for v := 1; v < len(row); v++ {
		if row[v] > bestVal {
			bestVal = row[v]
			best = v
		}
	}
	return best
}

// GenerateGreedy appends up to maxNew argmax-sampled tokens to prompt,
// stopping early at EOSTokenID. Uses BitNetDecoder (bitnet_decode.go) —
// one batched Prefill over the prompt, then one O(pos) Step per emitted
// token — instead of recomputing Forward over the whole sequence on every
// step; same signature and same results as the old O(n²) implementation
// (see cortex/bitnet_decode_test.go's naiveGreedy for the equivalence
// check against that old algorithm).
func (m *BitNetModel) GenerateGreedy(prompt []int, maxNew int) []int {
	seq := make([]int, len(prompt))
	copy(seq, prompt)
	if maxNew <= 0 || len(prompt) == 0 {
		return seq
	}

	dec := NewBitNetDecoder(m)
	logits := dec.Prefill(prompt)

	for i := 0; i < maxNew; i++ {
		best := argmaxFloat32(logits)
		seq = append(seq, best)
		if best == m.Cfg.EOSTokenID {
			break
		}
		if i == maxNew-1 || dec.Len() >= m.Cfg.MaxSeqLen {
			break
		}
		logits = dec.Step(best)
	}
	return seq
}

// GenerateSampled appends up to maxNew sampled tokens to prompt using
// BitNetDecoder for O(pos)-per-step incremental decoding, with the same
// temperature / top-k / top-p / repetition-penalty semantics as
// cortex/transformer_sampling.go's GenerateSampled (MiniTransformer) and
// cmd/nxtf-run: repetition penalty first (on raw logits), then
// temperature, then top-k/top-p nucleus sampling — reusing
// applyRepetitionPenalty and sampleTopKTopP directly rather than
// reimplementing them. Stops at Cfg.EOSTokenID and at any id in the
// optional stopIDs (BitNet-2B4T instruct uses <|eot_id|>==128009, i.e.
// tok.EotID()).
func (m *BitNetModel) GenerateSampled(prompt []int, maxNew int, temp float64, topK int, topP float64, repPenalty float64, rng *rand.Rand, stopIDs ...int) []int {
	seq := make([]int, len(prompt))
	copy(seq, prompt)
	if maxNew <= 0 || len(prompt) == 0 {
		return seq
	}

	cfg := SampleConfig{
		MaxNewTokens:      maxNew,
		Temperature:       float32(temp),
		TopK:              topK,
		TopP:              float32(topP),
		RepetitionPenalty: float32(repPenalty),
	}.normalise(m.Cfg.VocabSize)

	stop := make(map[int]bool, len(stopIDs)+1)
	stop[m.Cfg.EOSTokenID] = true
	for _, id := range stopIDs {
		stop[id] = true
	}

	dec := NewBitNetDecoder(m)
	logits := dec.Prefill(prompt)

	for i := 0; i < cfg.MaxNewTokens; i++ {
		applyRepetitionPenalty(logits, seq, cfg.RepetitionWindow, cfg.RepetitionPenalty)
		for j := range logits {
			logits[j] /= cfg.Temperature
		}

		next := sampleTopKTopP(rng, logits, cfg.TopK, cfg.TopP)
		seq = append(seq, next)
		if stop[next] {
			break
		}
		if i == cfg.MaxNewTokens-1 || dec.Len() >= m.Cfg.MaxSeqLen {
			break
		}
		logits = dec.Step(next)
	}
	return seq
}

// ParamCount returns the total number of scalar parameters: the tied
// embedding table, the final norm, and per layer the four RMSNorm weight
// vectors plus the seven BitLinear weight matrices (Out*In each).
func (m *BitNetModel) ParamCount() int {
	count := len(m.Embed) + len(m.FinalNorm)
	for _, l := range m.Layers {
		count += len(l.AttnNorm) + len(l.FFNNorm) + len(l.AttnSubNorm) + len(l.FFNSubNorm)
		count += l.Q.In * l.Q.Out
		count += l.K.In * l.K.Out
		count += l.V.In * l.V.Out
		count += l.O.In * l.O.Out
		count += l.Gate.In * l.Gate.Out
		count += l.Up.In * l.Up.Out
		count += l.Down.In * l.Down.Out
	}
	return count
}
