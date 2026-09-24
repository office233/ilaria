package cortex

// vision_siglip.go — SigLIP2-base vision tower + pixel-shuffle token
// reduction + 2-layer MLP projector, for Ilaria's "eyes" (stage 1 —
// forge/multimodal/vision_adapter.py is the PyTorch ground truth this
// mirrors; see that file's module docstring for the architecture
// overview). CPU float32 only, inference only — no training.
//
// Ground truth is the installed `transformers` 5.3.0 source
// (transformers/models/siglip/modeling_siglip.py:
// SiglipVisionTransformer/SiglipVisionEmbeddings/SiglipEncoderLayer/
// SiglipAttention/SiglipMLP) for google/siglip2-base-patch16-512, whose
// config.json declares model_type "siglip" (the fixed-512px SiglipModel
// architecture, not the NaFlex variable-resolution Siglip2Model family —
// confirmed by inspecting vision_config in the downloaded checkpoint) with
// vision_config overriding only image_size=512; every other
// SiglipVisionConfig field is that class's own default: patch_size=16,
// hidden_size=768, num_hidden_layers=12, num_attention_heads=12,
// intermediate_size=3072, hidden_act="gelu_pytorch_tanh",
// layer_norm_eps=1e-6. The checkpoint's vision_model.head.* (an
// attention-pooling head, SiglipMultiheadAttentionPoolingHead) is NOT
// loaded/implemented here: vision_adapter.py's VisionAdapter.forward only
// ever reads `.last_hidden_state` (the encoder's output after
// post_layernorm), never `.pooler_output`.
//
// Architecture (SiglipVisionTransformer.forward):
//
//	patch_embeds = Conv2d(pixel_values, kernel=patch, stride=patch)   # [768, 32, 32]
//	x = patch_embeds.flatten(2).transpose(1,2) + position_embedding   # [1024, 768]
//	for each of 12 layers (pre-norm, BIDIRECTIONAL — no causal mask):
//	    residual = x; x = LN1(x); x = MHA(x); x = residual + x
//	    residual = x; x = LN2(x); x = MLP(x); x = residual + x        # MLP: fc1 -> gelu_tanh -> fc2
//	last_hidden_state = post_layernorm(x)                              # [1024, 768]
//
// Conv2d patch embedding is implemented as unfold + matmul: each 16x16x3
// patch is flattened in (channel, kh, kw) row-major order — the same order
// forge/multimodal/export_tower.py flattens the PyTorch conv weight
// [out=768, in=3, kh=16, kw=16] into before transposing it to cortex's
// [in=768, out=768] linear convention (see that file's doc comment) — so
// dot(patch_vector, PatchEmbedWeight[:, oc]) reproduces
// Conv2d.forward's sum_{ic,kh,kw} exactly.
//
// Attention: standard bidirectional multi-head self-attention (SiglipAttention
// — is_causal=False, no attention_mask), scale = head_dim^-0.5 = 1/sqrt(64)
// (768/12 heads = 64 per head) — NOT bitnet.go's GQA/RoPE/causal attention,
// which this file does not reuse (different model family entirely).
//
// After the tower, forge/multimodal/vision_adapter.py's pixel_shuffle
// groups each 3x3 block of the 32x32 patch grid into one token (zero-padded
// to 33x33 first, since 32 isn't a multiple of 3 — "pad" policy, the only
// one the trained adapter uses) — see PixelShuffle's doc comment for the
// exact channel-concatenation order, mirrored bit-for-bit. The resulting
// 121 tokens of 768*9=6912 dims go through a 2-layer MLP projector
// (Linear 6912->mlp_hidden, GELU, Linear mlp_hidden->llm_hidden) — note
// this GELU is nn.GELU()'s exact erf-based variant, NOT gelu_pytorch_tanh
// (see SiglipProjector.Forward's doc comment) — producing 121 embeddings
// of size llm_hidden (2560), one per image, ready to splice into
// BitNetDecoder.PrefillEmbeds alongside text token embeddings.

import (
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg" // format registration for DecodeImage
	_ "image/png"  // format registration for DecodeImage
	"io"
	"math"
)

// DecodeImage decodes a PNG or JPEG image from r (format auto-detected via
// the standard library's image.Decode, using the format decoders
// registered by this file's blank imports) — the entry point
// cmd/ilaria-see and this package's own tests use instead of importing
// image/png or image/jpeg directly.
func DecodeImage(r io.Reader) (image.Image, string, error) {
	return image.Decode(r)
}

// ─────────────────────────────────────────────────────────────────────
// Config + weight types
// ─────────────────────────────────────────────────────────────────────

// SiglipVisionConfig holds the tower's hyperparameters — field values for
// google/siglip2-base-patch16-512 come from forge/multimodal/export_tower.py
// (which reads them straight off the loaded HF SiglipVisionConfig).
type SiglipVisionConfig struct {
	ImageSize    int
	PatchSize    int
	Hidden       int
	NumLayers    int
	NumHeads     int
	Intermediate int
	NumChannels  int
	NumPositions int // (ImageSize/PatchSize)^2 — no class token, no interpolation

	LayerNormEps float64
	HiddenAct    string // must be "gelu_pytorch_tanh" — the only variant implemented
}

func (cfg SiglipVisionConfig) gridSide() int {
	return cfg.ImageSize / cfg.PatchSize
}

func (cfg SiglipVisionConfig) headDim() int {
	return cfg.Hidden / cfg.NumHeads
}

// siglipEncoderLayer holds one pre-norm transformer block's weights.
// Linear weights are stored [in,out] (cortex's row-vector convention,
// y = x @ W — see forge/multimodal/export_tower.py's doc comment for the
// transpose-from-PyTorch note), biases [out].
type siglipEncoderLayer struct {
	LN1Weight, LN1Bias []float32 // len Hidden
	LN2Weight, LN2Bias []float32 // len Hidden

	QWeight, QBias []float32 // [Hidden,Hidden], [Hidden]
	KWeight, KBias []float32
	VWeight, VBias []float32
	OWeight, OBias []float32 // out_proj

	FC1Weight, FC1Bias []float32 // [Hidden,Intermediate], [Intermediate]
	FC2Weight, FC2Bias []float32 // [Intermediate,Hidden], [Hidden]
}

// SiglipVisionTower is the frozen SigLIP2 vision encoder: patch embedding,
// position embedding, NumLayers encoder blocks, final post-layernorm.
type SiglipVisionTower struct {
	Cfg SiglipVisionConfig

	PatchEmbedWeight []float32 // [NumChannels*PatchSize*PatchSize, Hidden]
	PatchEmbedBias   []float32 // [Hidden]
	PositionEmbed    []float32 // [NumPositions*Hidden] row-major, index = position*Hidden

	Layers []*siglipEncoderLayer

	PostLNWeight, PostLNBias []float32 // [Hidden]
}

// NewSiglipVisionTower allocates a zero-initialized tower ready for a
// loader (cortex/vision_siglip_persist.go) to fill in.
func NewSiglipVisionTower(cfg SiglipVisionConfig) *SiglipVisionTower {
	inFeat := cfg.NumChannels * cfg.PatchSize * cfg.PatchSize
	layers := make([]*siglipEncoderLayer, cfg.NumLayers)
	for i := range layers {
		layers[i] = &siglipEncoderLayer{
			LN1Weight: make([]float32, cfg.Hidden), LN1Bias: make([]float32, cfg.Hidden),
			LN2Weight: make([]float32, cfg.Hidden), LN2Bias: make([]float32, cfg.Hidden),
			QWeight: make([]float32, cfg.Hidden*cfg.Hidden), QBias: make([]float32, cfg.Hidden),
			KWeight: make([]float32, cfg.Hidden*cfg.Hidden), KBias: make([]float32, cfg.Hidden),
			VWeight: make([]float32, cfg.Hidden*cfg.Hidden), VBias: make([]float32, cfg.Hidden),
			OWeight: make([]float32, cfg.Hidden*cfg.Hidden), OBias: make([]float32, cfg.Hidden),
			FC1Weight: make([]float32, cfg.Hidden*cfg.Intermediate), FC1Bias: make([]float32, cfg.Intermediate),
			FC2Weight: make([]float32, cfg.Intermediate*cfg.Hidden), FC2Bias: make([]float32, cfg.Hidden),
		}
	}
	return &SiglipVisionTower{
		Cfg:              cfg,
		PatchEmbedWeight: make([]float32, inFeat*cfg.Hidden),
		PatchEmbedBias:   make([]float32, cfg.Hidden),
		PositionEmbed:    make([]float32, cfg.NumPositions*cfg.Hidden),
		Layers:           layers,
		PostLNWeight:     make([]float32, cfg.Hidden),
		PostLNBias:       make([]float32, cfg.Hidden),
	}
}

// ─────────────────────────────────────────────────────────────────────
// Forward
// ─────────────────────────────────────────────────────────────────────

// Forward runs the full tower over one image's preprocessed pixel values
// (CHW float32, len NumChannels*ImageSize*ImageSize — see PreprocessImage)
// and returns last_hidden_state as [NumPositions][Hidden].
func (m *SiglipVisionTower) Forward(pixelValues []float32) [][]float32 {
	cfg := m.Cfg
	x := m.patchEmbed(pixelValues)

	hidden := cfg.Hidden
	for t := range x {
		pe := m.PositionEmbed[t*hidden : (t+1)*hidden]
		row := x[t]
		for k := 0; k < hidden; k++ {
			row[k] += pe[k]
		}
	}

	for _, layer := range m.Layers {
		x = m.encoderLayer(layer, x)
	}

	return siglipLayerNorm(x, m.PostLNWeight, m.PostLNBias, cfg.LayerNormEps)
}

// patchEmbed unfolds pixelValues into NumPositions non-overlapping
// PatchSize x PatchSize x NumChannels patches (row-major over the patch
// grid, matching Conv2d.forward's output flatten(2).transpose(1,2) order —
// see file doc comment) and projects each through PatchEmbedWeight/Bias.
func (m *SiglipVisionTower) patchEmbed(pixelValues []float32) [][]float32 {
	cfg := m.Cfg
	P := cfg.PatchSize
	grid := cfg.gridSide()
	H := cfg.ImageSize
	inFeat := cfg.NumChannels * P * P
	numPatches := grid * grid

	if len(pixelValues) != cfg.NumChannels*H*H {
		panic(fmt.Sprintf("cortex: SiglipVisionTower.patchEmbed: pixelValues has %d values, want %d", len(pixelValues), cfg.NumChannels*H*H))
	}

	patches := make([][]float32, numPatches)
	for gy := 0; gy < grid; gy++ {
		for gx := 0; gx < grid; gx++ {
			vec := make([]float32, inFeat)
			idx := 0
			for ic := 0; ic < cfg.NumChannels; ic++ {
				planeOff := ic * H * H
				for kh := 0; kh < P; kh++ {
					rowOff := planeOff + (gy*P+kh)*H + gx*P
					for kw := 0; kw < P; kw++ {
						vec[idx] = pixelValues[rowOff+kw]
						idx++
					}
				}
			}
			patches[gy*grid+gx] = vec
		}
	}
	return denseForward(patches, m.PatchEmbedWeight, m.PatchEmbedBias, inFeat, cfg.Hidden)
}

// encoderLayer runs one pre-norm block (attention sub-layer + MLP
// sub-layer, each with its own residual) — matches SiglipEncoderLayer.forward.
func (m *SiglipVisionTower) encoderLayer(layer *siglipEncoderLayer, x [][]float32) [][]float32 {
	cfg := m.Cfg
	normed1 := siglipLayerNorm(x, layer.LN1Weight, layer.LN1Bias, cfg.LayerNormEps)
	attnOut := siglipAttention(layer, normed1, cfg)
	resid1 := addRows(x, attnOut)

	normed2 := siglipLayerNorm(resid1, layer.LN2Weight, layer.LN2Bias, cfg.LayerNormEps)
	mlpOut := siglipMLP(layer, normed2, cfg)
	return addRows(resid1, mlpOut)
}

// siglipAttention runs bidirectional (non-causal) multi-head
// self-attention over the whole sequence — matches SiglipAttention.forward
// with is_causal=False and no attention_mask (vision tokens attend to
// every other token, unlike bitnet.go's causal GQA attention).
func siglipAttention(layer *siglipEncoderLayer, xNormed [][]float32, cfg SiglipVisionConfig) [][]float32 {
	T := len(xNormed)
	hidden := cfg.Hidden
	heads := cfg.NumHeads
	hd := cfg.headDim()

	Q := denseForward(xNormed, layer.QWeight, layer.QBias, hidden, hidden)
	K := denseForward(xNormed, layer.KWeight, layer.KBias, hidden, hidden)
	V := denseForward(xNormed, layer.VWeight, layer.VBias, hidden, hidden)

	scale := float32(1.0 / math.Sqrt(float64(hd)))
	out := make([][]float32, T)
	for t := range out {
		out[t] = make([]float32, hidden)
	}

	// Score/softmax-sum/weighted-V-sum reductions accumulate in float64
	// (same rationale as denseForward's doc comment — T=1024 terms per
	// weighted sum is a large enough reduction for float32 summation-order
	// drift to matter against PyTorch's own eager_attention_forward, which
	// computes scores/softmax in float32 but via torch's own (blocked)
	// matmul and softmax reduction kernels).
	bitnetParallelFor(T, func(start, end int) {
		weights := make([]float64, T)
		accOut := make([]float64, hd)
		for ti := start; ti < end; ti++ {
			for h := 0; h < heads; h++ {
				qv := Q[ti][h*hd : (h+1)*hd]

				maxScore := math.Inf(-1)
				for s := 0; s < T; s++ {
					kv := K[s][h*hd : (h+1)*hd]
					var dot float64
					for kk := 0; kk < hd; kk++ {
						dot += float64(qv[kk]) * float64(kv[kk])
					}
					dot *= float64(scale)
					weights[s] = dot
					if dot > maxScore {
						maxScore = dot
					}
				}
				var sum float64
				for s := 0; s < T; s++ {
					e := math.Exp(weights[s] - maxScore)
					weights[s] = e
					sum += e
				}
				inv := 1 / sum

				for kk := range accOut {
					accOut[kk] = 0
				}
				for s := 0; s < T; s++ {
					w := weights[s] * inv
					vv := V[s][h*hd : (h+1)*hd]
					for kk := 0; kk < hd; kk++ {
						accOut[kk] += w * float64(vv[kk])
					}
				}
				outSlice := out[ti][h*hd : (h+1)*hd]
				for kk := range outSlice {
					outSlice[kk] = float32(accOut[kk])
				}
			}
		}
	})

	return denseForward(out, layer.OWeight, layer.OBias, hidden, hidden)
}

// siglipMLP computes fc2(gelu_pytorch_tanh(fc1(x))) — matches
// SiglipMLP.forward with hidden_act="gelu_pytorch_tanh".
func siglipMLP(layer *siglipEncoderLayer, x [][]float32, cfg SiglipVisionConfig) [][]float32 {
	h := denseForward(x, layer.FC1Weight, layer.FC1Bias, cfg.Hidden, cfg.Intermediate)
	geluTanhInPlace(h)
	return denseForward(h, layer.FC2Weight, layer.FC2Bias, cfg.Intermediate, cfg.Hidden)
}

// ─────────────────────────────────────────────────────────────────────
// Shared helpers: dense (float32) linear, LayerNorm, GELU variants, add
// ─────────────────────────────────────────────────────────────────────

// denseForward computes y = x @ w + b for every row of x, where w is
// stored [in,out] row-major (cortex's linear convention) and b has length
// out. Accumulates each output row in float64 (rounding to float32 only
// once, at the end) rather than float32 — PyTorch's CPU GEMM (used for
// every nn.Linear in the reference tower) accumulates with blocked/SIMD
// reductions that are far less error-prone than a naive sequential float32
// sum over `in` terms (up to 3072 here); float64 accumulation closes most
// of that gap cheaply, since x/w/y stay float32 and only the running sum
// briefly needs the wider type. Row-parallel over bitnetParallelFor
// (bitnet_linear.go) — safe here too since every row of the output is
// independent and each goroutine only ever writes the disjoint y[t]
// indices its [start,end) chunk owns.
func denseForward(x [][]float32, w, b []float32, in, out int) [][]float32 {
	T := len(x)
	y := make([][]float32, T)
	bitnetParallelFor(T, func(start, end int) {
		acc := make([]float64, out)
		for t := start; t < end; t++ {
			for j := range acc {
				acc[j] = float64(b[j])
			}
			xt := x[t]
			for i := 0; i < in; i++ {
				xi := float64(xt[i])
				if xi == 0 {
					continue
				}
				wOff := i * out
				for j := 0; j < out; j++ {
					acc[j] += xi * float64(w[wOff+j])
				}
			}
			row := make([]float32, out)
			for j := range row {
				row[j] = float32(acc[j])
			}
			y[t] = row
		}
	})
	return y
}

// addRows returns a fresh a+b (row-wise element-wise sum); a and b must
// have identical shape.
func addRows(a, b [][]float32) [][]float32 {
	out := make([][]float32, len(a))
	for t := range a {
		ar, br := a[t], b[t]
		row := make([]float32, len(ar))
		for i := range ar {
			row[i] = ar[i] + br[i]
		}
		out[t] = row
	}
	return out
}

// siglipLayerNorm applies LayerNorm along the last dimension with a
// caller-supplied eps (SigLIP2-base's layer_norm_eps is 1e-6 — cortex's
// existing Tensor.LayerNormInto (tensor.go) hardcodes 1e-5, which is
// Ilaria's own transformer convention, not SigLIP2's, so this file keeps
// its own copy rather than reusing that one). Accumulates mean/variance in
// float64, matching bitnet_decode.go's rmsNormInto convention, for the
// tightest practical match to PyTorch's own reduction.
func siglipLayerNorm(x [][]float32, gamma, beta []float32, eps float64) [][]float32 {
	n := len(gamma)
	out := make([][]float32, len(x))
	for t, row := range x {
		var mean float64
		for _, v := range row {
			mean += float64(v)
		}
		mean /= float64(n)

		var variance float64
		for _, v := range row {
			d := float64(v) - mean
			variance += d * d
		}
		variance /= float64(n)
		invStd := 1.0 / math.Sqrt(variance+eps)

		outRow := make([]float32, n)
		for i := 0; i < n; i++ {
			norm := (float64(row[i]) - mean) * invStd
			outRow[i] = gamma[i]*float32(norm) + beta[i]
		}
		out[t] = outRow
	}
	return out
}

// geluTanhInPlace applies the gelu_pytorch_tanh approximation in place —
// the same formula as Tensor.GELUInPlace (cortex/tensor.go):
// 0.5*x*(1+tanh(sqrt(2/pi)*(x+0.044715*x^3))). Duplicated (rather than
// routing through Tensor, which needs one contiguous backing array and
// this package's [][]float32 rows are independently allocated) so the
// encoder MLP can use it directly; the formula itself is exactly
// Tensor.GELUInPlace's, not a re-derivation.
func geluTanhInPlace(x [][]float32) {
	sqrt2OverPi := float32(math.Sqrt(2.0 / math.Pi))
	for _, row := range x {
		for i, v := range row {
			inner := sqrt2OverPi * (v + 0.044715*v*v*v)
			row[i] = 0.5 * v * (1 + float32(math.Tanh(float64(inner))))
		}
	}
}

// geluExactInPlace applies PyTorch's default nn.GELU() — the exact
// erf-based formula 0.5*x*(1+erf(x/sqrt(2))), NOT the tanh approximation
// above. forge/multimodal/vision_adapter.py's projector uses plain
// nn.GELU() (see VisionAdapter.__init__: `nn.Sequential(nn.Linear(...),
// nn.GELU(), nn.Linear(...))`), which defaults to approximate="none" —
// the erf variant — so SiglipProjector.Forward must NOT reuse
// geluTanhInPlace here.
func geluExactInPlace(x [][]float32) {
	const invSqrt2 = 0.70710678118654752440
	for _, row := range x {
		for i, v := range row {
			row[i] = 0.5 * v * (1 + float32(math.Erf(float64(v)*invSqrt2)))
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// Pixel shuffle
// ─────────────────────────────────────────────────────────────────────

// PixelShuffle groups each contiguous sxs block of a side x side patch
// grid (row-major, tokens[gy*side+gx]) into one token, concatenating the
// block's s*s channel vectors in (si,sj) row-major order — mirroring
// forge/multimodal/vision_adapter.py's pixel_shuffle(x, side, side, s,
// policy="pad") bit-for-bit:
//
//	x = x.view(1, side, side, c)
//	pad_h, pad_w = (-side)%s, (-side)%s        # zero-pad up to next mult of s
//	x = pad(x); h, w = side+pad_h, side+pad_w
//	x = x.view(1, h/s, s, w/s, s, c).permute(0,1,3,2,4,5).view(1, (h/s)*(w/s), s*s*c)
//
// i.e. output token (I,J) (I,J in [0, ceil(side/s))) at index I*ceil(side/s)+J
// is the concatenation, for si in [0,s) then sj in [0,s), of grid position
// (I*s+si, J*s+sj)'s channel vector — zero-filled wherever that position
// falls in the padding (gy>=side or gx>=side). Only the "pad" policy is
// implemented: the trained adapter (grid_policy default) always uses it.
func PixelShuffle(tokens [][]float32, side, s int) [][]float32 {
	if len(tokens) != side*side {
		panic(fmt.Sprintf("cortex: PixelShuffle: expected %d tokens (%dx%d grid), got %d", side*side, side, side, len(tokens)))
	}
	if len(tokens) == 0 {
		return nil
	}
	c := len(tokens[0])
	rSide := (side + s - 1) / s // ceil(side/s)

	out := make([][]float32, rSide*rSide)
	for I := 0; I < rSide; I++ {
		for J := 0; J < rSide; J++ {
			vec := make([]float32, s*s*c)
			for si := 0; si < s; si++ {
				gy := I*s + si
				if gy >= side {
					continue // leaves this block-row's slots zero
				}
				for sj := 0; sj < s; sj++ {
					gx := J*s + sj
					if gx >= side {
						continue
					}
					off := (si*s + sj) * c
					copy(vec[off:off+c], tokens[gy*side+gx])
				}
			}
			out[I*rSide+J] = vec
		}
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// Projector
// ─────────────────────────────────────────────────────────────────────

// SiglipProjector is the trainable 2-layer MLP
// (Linear -> GELU(exact) -> Linear) that maps pixel-shuffled tower tokens
// (len In = vision_hidden*shuffle_factor^2, e.g. 768*9=6912) to
// LLM-hidden-sized image embeddings (len Out, e.g. 2560) — matches
// VisionAdapter.projector (forge/multimodal/vision_adapter.py). Weights
// are [in,out] (cortex convention — see forge/multimodal/export_adapter.py's
// doc comment on the PyTorch nn.Linear [out,in] -> cortex [in,out] transpose).
type SiglipProjector struct {
	In, Mlp, Out int
	FC1Weight    []float32 // [In,Mlp]
	FC1Bias      []float32 // [Mlp]
	FC2Weight    []float32 // [Mlp,Out]
	FC2Bias      []float32 // [Out]
}

// Forward runs fc2(gelu_exact(fc1(x))) for every row of x (each row: one
// pixel-shuffled image token, len p.In) and returns len(x) rows of len p.Out.
func (p *SiglipProjector) Forward(x [][]float32) [][]float32 {
	h := denseForward(x, p.FC1Weight, p.FC1Bias, p.In, p.Mlp)
	geluExactInPlace(h)
	return denseForward(h, p.FC2Weight, p.FC2Bias, p.Mlp, p.Out)
}

// ─────────────────────────────────────────────────────────────────────
// Image preprocessing
// ─────────────────────────────────────────────────────────────────────

// PreprocessImage converts a decoded image to SigLIP2-normalized CHW
// float32 pixel values (len 3*size*size): resize to size x size, rescale
// by 1/255, then normalize with mean=std=0.5 (equivalent to
// pixel/127.5 - 1), matching preprocessor_config.json for
// google/siglip2-base-patch16-512 (do_resize, resample=2/BILINEAR,
// rescale_factor=1/255, image_mean=image_std=[0.5,0.5,0.5]).
//
// Resize uses 2x2-neighbor bilinear interpolation with PIL's half-pixel
// coordinate convention (src = (dst+0.5)*scale - 0.5, clamped to the
// source extent) rather than PIL's own C `ImagingResample`, which applies
// a box+triangle filter with 8-bit fixed-point coefficients — the two
// agree exactly when the source is already size x size (scale=1, every
// sample lands exactly on an input pixel, zero interpolation weight on
// the neighbor) but can differ by up to ~1 count (of 255) per channel
// under true up/down-sampling — measured (and regression-tested) in
// cortex/vision_siglip_test.go's TestResizeBilinearRGBVsPIL against a
// PIL.Image.resize(..., resample=BILINEAR) reference fixture
// (forge/fixtures/resize_bilinear_fixture.json, a 37x41 synthetic source
// resized to 64x64): max |Δ| ≈ 1.0/255, mean |Δ| ≈ 0.30/255. Both of this
// package's dump_vision_reference.py fixtures are synthesized at exactly
// 512x512 to keep the tower equivalence check itself free of this source
// of drift.
func PreprocessImage(img image.Image, size int) []float32 {
	nrgba := toNRGBA(img)
	resized := resizeBilinearRGB(nrgba, size, size)

	out := make([]float32, 3*size*size)
	plane := size * size
	for y := 0; y < size; y++ {
		rowOff := y * resized.Stride
		for x := 0; x < size; x++ {
			po := rowOff + x*4
			idx := y*size + x
			out[0*plane+idx] = float32(resized.Pix[po])/127.5 - 1
			out[1*plane+idx] = float32(resized.Pix[po+1])/127.5 - 1
			out[2*plane+idx] = float32(resized.Pix[po+2])/127.5 - 1
		}
	}
	return out
}

// toNRGBA returns img as *image.NRGBA (non-premultiplied, 4 bytes/pixel,
// alpha dropped downstream by PreprocessImage), converting via image/draw
// only when img isn't already that concrete type.
func toNRGBA(img image.Image) *image.NRGBA {
	if n, ok := img.(*image.NRGBA); ok {
		return n
	}
	b := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Src)
	return dst
}

// resizeBilinearRGB resizes src to dstW x dstH using half-pixel-center
// bilinear interpolation (see PreprocessImage's doc comment for the exact
// convention and its measured deviation from PIL). Returns src itself,
// unmodified, when the size already matches (mathematically identical to
// resampling in that case, but skips the float round-trip through
// interpolation weights of 0/1).
func resizeBilinearRGB(src *image.NRGBA, dstW, dstH int) *image.NRGBA {
	b := src.Bounds()
	srcW, srcH := b.Dx(), b.Dy()
	if srcW == dstW && srcH == dstH {
		return src
	}

	dst := image.NewNRGBA(image.Rect(0, 0, dstW, dstH))
	scaleX := float64(srcW) / float64(dstW)
	scaleY := float64(srcH) / float64(dstH)

	srcAt := func(x, y, ch int) float64 {
		off := (y-b.Min.Y)*src.Stride + (x-b.Min.X)*4 + ch
		return float64(src.Pix[off])
	}
	clamp := func(v, lo, hi int) int {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}

	for oy := 0; oy < dstH; oy++ {
		sy := (float64(oy)+0.5)*scaleY - 0.5
		if sy < 0 {
			sy = 0
		}
		if sy > float64(srcH-1) {
			sy = float64(srcH - 1)
		}
		y0 := int(math.Floor(sy))
		y1 := clamp(y0+1, 0, srcH-1)
		wy := sy - float64(y0)

		for ox := 0; ox < dstW; ox++ {
			sx := (float64(ox)+0.5)*scaleX - 0.5
			if sx < 0 {
				sx = 0
			}
			if sx > float64(srcW-1) {
				sx = float64(srcW - 1)
			}
			x0 := int(math.Floor(sx))
			x1 := clamp(x0+1, 0, srcW-1)
			wx := sx - float64(x0)

			po := oy*dst.Stride + ox*4
			for ch := 0; ch < 3; ch++ {
				top := srcAt(b.Min.X+x0, b.Min.Y+y0, ch)*(1-wx) + srcAt(b.Min.X+x1, b.Min.Y+y0, ch)*wx
				bot := srcAt(b.Min.X+x0, b.Min.Y+y1, ch)*(1-wx) + srcAt(b.Min.X+x1, b.Min.Y+y1, ch)*wx
				v := top*(1-wy) + bot*wy
				dst.Pix[po+ch] = uint8(math.Round(clampFloat(v, 0, 255)))
			}
			dst.Pix[po+3] = 255
		}
	}
	return dst
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
