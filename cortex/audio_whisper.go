package cortex

// audio_whisper.go — pure-Go port of the openai/whisper-small ENCODER
// (frozen — never fine-tuned, see forge/multimodal/audio_adapter.py's
// AudioAdapterConfig.freeze_encoder) plus its log-mel front end, the
// stack_frames token-reduction op, and the audio projector module shape,
// for Ilaria's "ears" (stage 1 — forge/multimodal/audio_adapter.py is the
// PyTorch ground truth this mirrors; see that file's module docstring for
// the architecture overview, and cortex/vision_siglip.go for the "eyes"
// tower this file's structure deliberately parallels as closely as the
// audio modality allows). CPU float32 only, inference only — no training,
// and no GPU hook (unlike vision_siglip.go's SiglipVisionTower.gpu): the
// Whisper encoder forward is the only expensive piece here and every
// project deliverable routes it through the CPU path.
//
// Ground truth is the installed `transformers` 5.3.0 source
// (transformers/models/whisper/modeling_whisper.py:
// WhisperEncoder/WhisperEncoderLayer/WhisperAttention;
// transformers/models/whisper/feature_extraction_whisper.py:
// WhisperFeatureExtractor) for openai/whisper-small, whose config.json
// declares d_model=768, encoder_layers=12, encoder_attention_heads=12,
// encoder_ffn_dim=3072, num_mel_bins=80, max_source_positions=1500,
// activation_function="gelu" (transformers' ACT2FN["gelu"] is
// GELUActivation() -> nn.functional.gelu, approximate="none" — the EXACT
// erf formula, same as SigLIP2's projector GELU — see geluExactInPlace in
// vision_siglip.go, reused unchanged here; NOT gelu_pytorch_tanh, which
// this file never uses), and whose preprocessor_config.json declares
// n_fft=400, hop_length=160, chunk_length=30 (-> n_samples=480000,
// nb_max_frames=3000 at the default 16 kHz sampling rate). See
// forge/multimodal/export_whisper_tower.py's module docstring for the
// exact checkpoint facts this was verified against (LayerNorm eps
// 1e-5 — PyTorch's nn.LayerNorm default, unlike SigLIP2's custom 1e-6;
// self_attn.k_proj's bias=False, exported as an all-zero bias vector so
// every projection can be treated uniformly here).
//
// Front end — LogMel (WhisperFeatureExtractor._torch_extract_fbank_features,
// the path `transformers` takes whenever torch is installed, which is the
// ground truth this was checked against — NOT the numpy fallback path):
//
//	buf   = samples, zero-padded/truncated to n_samples=chunk_length*sampling_rate
//	padded = reflect-pad buf by n_fft/2 on both sides (torch.stft's
//	         center=True default, pad_mode="reflect" — see reflectPadFloat64)
//	frame t (t in [0,nb_max_frames)) = padded[t*hop_length : t*hop_length+n_fft)
//	         windowed by a PERIODIC Hann window (torch.hann_window(n_fft),
//	         periodic=True default: w[n] = 0.5 - 0.5*cos(2*pi*n/n_fft) — the
//	         denominator is n_fft, NOT n_fft-1, which is the (unused) symmetric
//	         variant — see hannWindowPeriodic)
//	spectrum = real DFT of the windowed frame, bins 0..n_fft/2 inclusive
//	         (onesided, matching torch.stft's real-input default — see
//	         dftTables/LogMel's inner loop; a direct O(n_fft) per bin DFT via
//	         precomputed cos/sin tables, not an FFT — correctness first, per
//	         the task spec, and n_fft=400 isn't a power of 2 anyway)
//	power    = |spectrum|^2 (magnitudes squared)
//	mel      = melFilters[nMels,nFreq] . power   (plain matmul — no slaney
//	         mel-scale formula in Go at all: the filterbank is exported
//	         verbatim as a tensor by export_whisper_tower.py, straight off
//	         the real WhisperFeatureExtractor's own `.mel_filters`)
//	logMel   = log10(max(mel, 1e-10))
//	logMel   = max(logMel, globalMax(logMel) - 8)     ("max-8" clamp,
//	         globalMax taken over the WHOLE [nMels,T] matrix — matches the
//	         torch path's per-CLIP (not per-frame) `log_spec.max()`)
//	logMel   = (logMel + 4) / 4
//
// Encoder (WhisperEncoder.forward):
//
//	x = gelu(conv1(mel))          # Conv1d(nMels,hidden,k=3,stride=1,pad=1)
//	x = gelu(conv2(x))            # Conv1d(hidden,hidden,k=3,stride=2,pad=1)
//	x = x.permute + embed_positions[0:T']   # T'=max_source_positions always
//	                                         # (mel is always the fixed
//	                                         # nb_max_frames-length window,
//	                                         # so conv2's output length is
//	                                         # always exactly max_source_positions
//	                                         # — see WhisperEncoder.forward's
//	                                         # own expected_seq_length assert)
//	for each of 12 layers (pre-LN, BIDIRECTIONAL — no causal mask, same
//	    shape as SigLIP2's encoderLayer, different LN eps/activation):
//	    residual = x; x = LN1(x); x = MHA(x); x = residual + x
//	    residual = x; x = LN2(x); x = MLP(x); x = residual + x   # MLP: fc1 -> gelu(exact) -> fc2
//	last_hidden_state = final_layernorm(x)                        # [1500,768]
//
// Downstream of the encoder (mirrors audio_adapter.AudioAdapter.forward
// exactly — NOT part of WhisperEncoder.forward itself):
//
//	cropped = last_hidden_state[:realFrameCount]   # see RealFrameCount
//	stacked = StackFrames(cropped, stack_factor=8) # [ceil(L/8), 8*768]
//	embeds  = AudioProjector.Forward(stacked)      # [N, llm_hidden]
//
// Conv1d weight flatten/unfold order: nn.Conv1d stores weight
// [out_channels,in_channels,kernel_size]; forge/multimodal/
// export_whisper_tower.py flattens each output channel's (in_channels,
// kernel) cube row-major (in_channels outermost, kernel innermost) before
// transposing to cortex's [in,out] convention — conv1dGeluForward's
// im2col unfold below builds patch vectors in that exact same order, one
// dimension shorter than vision_siglip.go's Conv2d patchEmbed unfold
// (which additionally has a spatial kh/kw pair instead of Conv1d's single
// kernel axis).
//
// Attention: standard bidirectional multi-head self-attention
// (WhisperAttention — no causal mask, no attention_mask; Whisper scales Q
// by head_dim^-0.5 before reshaping to heads rather than scaling the score
// matrix afterward, which is mathematically identical to
// vision_siglip.go's siglipAttention convention and not reproduced as a
// separate step here), scale = head_dim^-0.5 = 1/sqrt(64) (768/12 heads).

import (
	"math"
)

// ─────────────────────────────────────────────────────────────────────
// Config + weight types
// ─────────────────────────────────────────────────────────────────────

// WhisperEncoderConfig holds the tower's hyperparameters — field values
// for openai/whisper-small come from
// forge/multimodal/export_whisper_tower.py (which reads them straight off
// the loaded HF WhisperConfig + WhisperFeatureExtractor).
type WhisperEncoderConfig struct {
	NumMelBins         int
	Hidden             int
	NumLayers          int
	NumHeads           int
	Intermediate       int
	MaxSourcePositions int // encoder output length T' — always exactly this, never shorter (see file doc comment)

	NFFT         int
	HopLength    int
	ChunkLength  int // seconds
	SamplingRate int
	NumFreqBins  int // 1 + NFFT/2 — onesided real-DFT bin count

	LayerNormEps float64
	HiddenAct    string // must be "gelu" (exact erf) — the only variant implemented
}

func (cfg WhisperEncoderConfig) headDim() int {
	return cfg.Hidden / cfg.NumHeads
}

// NSamples is the fixed raw-sample window every clip is zero-padded/
// truncated to before framing (ChunkLength seconds at SamplingRate Hz) —
// matches WhisperFeatureExtractor.n_samples.
func (cfg WhisperEncoderConfig) NSamples() int {
	return cfg.ChunkLength * cfg.SamplingRate
}

// NumMelFrames is the fixed mel-frame count (T) LogMel always produces —
// matches WhisperFeatureExtractor.nb_max_frames = n_samples/hop_length.
func (cfg WhisperEncoderConfig) NumMelFrames() int {
	return cfg.NSamples() / cfg.HopLength
}

// whisperEncoderLayer holds one pre-norm transformer block's weights.
// Linear weights are stored [in,out] (cortex's row-vector convention),
// biases [out]. KBias is always an all-zero vector — WhisperAttention's
// k_proj has bias=False in the real checkpoint (see file doc comment) —
// so it can be added like every other projection's bias with no special
// case.
type whisperEncoderLayer struct {
	LN1Weight, LN1Bias []float32 // self_attn_layer_norm, len Hidden
	LN2Weight, LN2Bias []float32 // final_layer_norm, len Hidden

	QWeight, QBias []float32 // [Hidden,Hidden], [Hidden]
	KWeight, KBias []float32 // KBias is all zeros
	VWeight, VBias []float32
	OWeight, OBias []float32 // out_proj

	FC1Weight, FC1Bias []float32 // [Hidden,Intermediate], [Intermediate]
	FC2Weight, FC2Bias []float32 // [Intermediate,Hidden], [Hidden]
}

// WhisperEncoderTower is the frozen Whisper encoder: two strided Conv1d
// layers (+ exact GELU), fixed sinusoidal position embeddings, NumLayers
// encoder blocks, final LayerNorm — plus the log-mel front end's mel
// filterbank (MelFilters), so LogMel needs no separate weight source.
type WhisperEncoderTower struct {
	Cfg WhisperEncoderConfig

	Conv1Weight []float32 // [NumMelBins*3, Hidden]
	Conv1Bias   []float32 // [Hidden]
	Conv2Weight []float32 // [Hidden*3, Hidden]
	Conv2Bias   []float32 // [Hidden]

	EmbedPositions []float32 // [MaxSourcePositions*Hidden] row-major, index = position*Hidden

	Layers []*whisperEncoderLayer

	FinalLNWeight, FinalLNBias []float32 // [Hidden]

	MelFilters []float32 // [NumMelBins*NumFreqBins] row-major, index = melBin*NumFreqBins
}

// NewWhisperEncoderTower allocates a zero-initialized tower ready for a
// loader (cortex/audio_whisper_persist.go) to fill in.
func NewWhisperEncoderTower(cfg WhisperEncoderConfig) *WhisperEncoderTower {
	layers := make([]*whisperEncoderLayer, cfg.NumLayers)
	for i := range layers {
		layers[i] = &whisperEncoderLayer{
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
	return &WhisperEncoderTower{
		Cfg:            cfg,
		Conv1Weight:    make([]float32, cfg.NumMelBins*3*cfg.Hidden),
		Conv1Bias:      make([]float32, cfg.Hidden),
		Conv2Weight:    make([]float32, cfg.Hidden*3*cfg.Hidden),
		Conv2Bias:      make([]float32, cfg.Hidden),
		EmbedPositions: make([]float32, cfg.MaxSourcePositions*cfg.Hidden),
		Layers:         layers,
		FinalLNWeight:  make([]float32, cfg.Hidden),
		FinalLNBias:    make([]float32, cfg.Hidden),
		MelFilters:     make([]float32, cfg.NumMelBins*cfg.NumFreqBins),
	}
}

// ─────────────────────────────────────────────────────────────────────
// Log-mel front end
// ─────────────────────────────────────────────────────────────────────

// LogMel computes the log-mel spectrogram of samples (16 kHz mono
// float32, any length — zero-padded or truncated to the fixed
// Cfg.NSamples() window, matching WhisperFeatureExtractor's own
// padding="max_length" default) and returns it MEL-MAJOR: len(result) ==
// Cfg.NumMelBins, len(result[i]) == Cfg.NumMelFrames() — i.e. shape
// [80,T], the same axis order as the PyTorch reference's
// `input_features` and forge/multimodal/dump_audio_reference.py's
// "log_mel" JSON field (and its flattened "first64", which walks mel bin
// 0's frames before moving to mel bin 1 — comparable directly against
// result[0][:64]). See file doc comment for the exact math (reflect-pad,
// periodic Hann window, real DFT, mel matmul, log10/clamp/scale).
func (m *WhisperEncoderTower) LogMel(samples []float32) [][]float32 {
	cfg := m.Cfg
	nSamples := cfg.NSamples()

	buf := make([]float64, nSamples)
	n := len(samples)
	if n > nSamples {
		n = nSamples
	}
	for i := 0; i < n; i++ {
		buf[i] = float64(samples[i])
	}

	pad := cfg.NFFT / 2
	padded := reflectPadFloat64(buf, pad)

	numFreq := cfg.NumFreqBins
	T := cfg.NumMelFrames()

	window := hannWindowPeriodic(cfg.NFFT)
	cosTab, sinTab := dftTables(cfg.NFFT, numFreq)

	// frameLog[t][m] = log10(max(melPower, 1e-10)) — the max-8 clamp and
	// (x+4)/4 scale are applied afterward, once the WHOLE matrix's max is
	// known (see file doc comment — the clamp floor is a single scalar
	// over every (t,m), not per-frame).
	frameLog := make([][]float32, T)
	bitnetParallelFor(T, func(start, end int) {
		freqPow := make([]float64, numFreq)
		for t := start; t < end; t++ {
			base := t * cfg.HopLength
			for k := 0; k < numFreq; k++ {
				var re, im float64
				rowCos := cosTab[k*cfg.NFFT : (k+1)*cfg.NFFT]
				rowSin := sinTab[k*cfg.NFFT : (k+1)*cfg.NFFT]
				for nIdx := 0; nIdx < cfg.NFFT; nIdx++ {
					v := padded[base+nIdx] * window[nIdx]
					re += v * rowCos[nIdx]
					im -= v * rowSin[nIdx]
				}
				freqPow[k] = re*re + im*im
			}
			row := make([]float32, cfg.NumMelBins)
			for mi := 0; mi < cfg.NumMelBins; mi++ {
				filt := m.MelFilters[mi*numFreq : (mi+1)*numFreq]
				var acc float64
				for k := 0; k < numFreq; k++ {
					acc += freqPow[k] * float64(filt[k])
				}
				if acc < 1e-10 {
					acc = 1e-10
				}
				row[mi] = float32(math.Log10(acc))
			}
			frameLog[t] = row
		}
	})

	globalMax := float32(math.Inf(-1))
	for _, row := range frameLog {
		for _, v := range row {
			if v > globalMax {
				globalMax = v
			}
		}
	}
	floor := globalMax - 8

	melMajor := make([][]float32, cfg.NumMelBins)
	for mi := range melMajor {
		melMajor[mi] = make([]float32, T)
	}
	for t := 0; t < T; t++ {
		row := frameLog[t]
		for mi := 0; mi < cfg.NumMelBins; mi++ {
			v := row[mi]
			if v < floor {
				v = floor
			}
			melMajor[mi][t] = (v + 4) / 4
		}
	}
	return melMajor
}

// reflectPadFloat64 pads x on both sides by pad samples using "reflect"
// mode (mirrors without repeating the boundary sample — numpy.pad's and
// PyTorch F.pad's/torch.stft's "reflect" convention, NOT "replicate"):
// out[i] = x[pad-i] for i in [0,pad) on the left (out[0]=x[pad],
// out[pad-1]=x[1]), and out[pad+n+j] = x[n-2-j] for j in [0,pad) on the
// right (out[pad+n]=x[n-2], out[pad+n+pad-1]=x[n-1-pad]). Requires
// pad < len(x).
func reflectPadFloat64(x []float64, pad int) []float64 {
	n := len(x)
	out := make([]float64, n+2*pad)
	for i := 0; i < pad; i++ {
		out[i] = x[pad-i]
	}
	copy(out[pad:pad+n], x)
	for j := 0; j < pad; j++ {
		out[pad+n+j] = x[n-2-j]
	}
	return out
}

// hannWindowPeriodic returns torch.hann_window(n, periodic=True)'s exact
// formula: w[i] = 0.5 - 0.5*cos(2*pi*i/n) for i in [0,n) — the
// denominator is n (the PERIODIC/STFT convention), not n-1 (the unused
// symmetric variant) — verified numerically against torch.hann_window(400)
// (max|Δ| ≈ 2.5e-7, i.e. float32 rounding only) while writing this file.
func hannWindowPeriodic(n int) []float64 {
	w := make([]float64, n)
	for i := 0; i < n; i++ {
		w[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n))
	}
	return w
}

// dftTables precomputes cos(2*pi*k*n/nfft) and sin(2*pi*k*n/nfft) for
// every (k,n) pair (k in [0,numFreq), n in [0,nfft)) used by LogMel's
// per-frame real DFT (X[k] = sum_n x[n]*exp(-2*pi*i*k*n/nfft), onesided:
// only bins 0..nfft/2 inclusive are computed, matching torch.stft's
// default for a real input). A direct O(nfft) per-bin sum via a
// precomputed table, not an FFT — nfft=400 isn't a power of 2, and
// correctness (not speed) is this file's first priority per the task
// spec; LogMel parallelizes across frames (bitnetParallelFor) to keep
// this affordable.
func dftTables(nfft, numFreq int) (cosTab, sinTab []float64) {
	cosTab = make([]float64, numFreq*nfft)
	sinTab = make([]float64, numFreq*nfft)
	for k := 0; k < numFreq; k++ {
		for n := 0; n < nfft; n++ {
			angle := 2 * math.Pi * float64(k) * float64(n) / float64(nfft)
			cosTab[k*nfft+n] = math.Cos(angle)
			sinTab[k*nfft+n] = math.Sin(angle)
		}
	}
	return cosTab, sinTab
}

// ─────────────────────────────────────────────────────────────────────
// Forward
// ─────────────────────────────────────────────────────────────────────

// Forward runs the full encoder over a mel-major log-mel spectrogram (as
// returned by LogMel — shape [NumMelBins][NumMelFrames]) and returns
// last_hidden_state as [MaxSourcePositions][Hidden] — ALWAYS that exact
// length, uncropped (see file doc comment: cropping to the real audio
// duration happens downstream, in RealFrameCount + slicing, mirroring
// audio_adapter.AudioAdapter.forward, which crops AFTER the full encoder
// forward, never inside it).
func (m *WhisperEncoderTower) Forward(mel [][]float32) [][]float32 {
	final, _, _ := m.ForwardDebug(mel, nil)
	return final
}

// ForwardDebug behaves like Forward but additionally returns the
// conv-stack output (gelu(conv2(gelu(conv1(mel)))), permuted to
// token-major — BEFORE the position embedding is added) and, for every
// 0-based layer index in captureLayers, the hidden state immediately
// AFTER that encoder layer runs (before the final LayerNorm, even for
// the last layer index) — see forge/multimodal/dump_audio_reference.py's
// module doc comment for the exact matching PyTorch-side definitions
// cortex/audio_whisper_test.go compares against. captureLayers may be
// nil (Forward's use — no capturing).
func (m *WhisperEncoderTower) ForwardDebug(mel [][]float32, captureLayers []int) (final, convOut [][]float32, captured map[int][][]float32) {
	cfg := m.Cfg
	x := transposeMel(mel) // [NumMelFrames][NumMelBins] token-major, for conv1's im2col

	x = conv1dGeluForward(x, m.Conv1Weight, m.Conv1Bias, cfg.NumMelBins, cfg.Hidden, 3, 1, 1)
	x = conv1dGeluForward(x, m.Conv2Weight, m.Conv2Bias, cfg.Hidden, cfg.Hidden, 3, 2, 1)

	convOut = make([][]float32, len(x))
	for t, row := range x {
		cp := make([]float32, len(row))
		copy(cp, row)
		convOut[t] = cp
	}

	for t := range x {
		pe := m.EmbedPositions[t*cfg.Hidden : (t+1)*cfg.Hidden]
		row := x[t]
		for k := 0; k < cfg.Hidden; k++ {
			row[k] += pe[k]
		}
	}

	if len(captureLayers) > 0 {
		captured = make(map[int][][]float32, len(captureLayers))
	}
	wantCapture := make(map[int]bool, len(captureLayers))
	for _, i := range captureLayers {
		wantCapture[i] = true
	}

	for li, layer := range m.Layers {
		x = m.encoderLayer(layer, x)
		if wantCapture[li] {
			cp := make([][]float32, len(x))
			for t, row := range x {
				r := make([]float32, len(row))
				copy(r, row)
				cp[t] = r
			}
			captured[li] = cp
		}
	}

	final = siglipLayerNorm(x, m.FinalLNWeight, m.FinalLNBias, cfg.LayerNormEps)
	return final, convOut, captured
}

// transposeMel converts mel-major [NumMelBins][T] (LogMel's return shape)
// to token-major [T][NumMelBins] — the convention conv1dGeluForward's
// im2col (and every transformer stage after it) uses, matching
// vision_siglip.go's own token-major [][]float32 rows-are-tokens
// convention throughout this package.
func transposeMel(mel [][]float32) [][]float32 {
	nMels := len(mel)
	if nMels == 0 {
		return nil
	}
	T := len(mel[0])
	out := make([][]float32, T)
	for t := 0; t < T; t++ {
		row := make([]float32, nMels)
		for mi := 0; mi < nMels; mi++ {
			row[mi] = mel[mi][t]
		}
		out[t] = row
	}
	return out
}

// conv1dGeluForward applies a 1-D convolution (kernel, stride, symmetric
// zero-padding) followed by the exact (erf-based) GELU, over token-major
// input x ([Tin][inCh], row t = time step t's inCh-wide channel vector —
// the same layout nn.Conv1d's [B,C,T] input represents per batch element,
// just transposed to put channels last) — matches nn.Conv1d(x) followed
// by nn.functional.gelu(...) exactly (both conv1 and conv2 in
// WhisperEncoder.forward apply gelu immediately after the conv, before
// anything else). weight is stored [inCh*kernel,outCh] (cortex
// convention), flattened per-output-channel (inCh,kernel) cube row-major,
// inCh outermost, kernel innermost — matching
// forge/multimodal/export_whisper_tower.py's _flatten_conv1d (see that
// file's doc comment). Reuses denseForward (vision_siglip.go) for the
// actual matmul — float64 accumulation, parallelized — via an im2col
// unfold, exactly as vision_siglip.go's patchEmbed unfolds Conv2d
// patches, one spatial dimension fewer.
func conv1dGeluForward(x [][]float32, weight, bias []float32, inCh, outCh, kernel, stride, padding int) [][]float32 {
	Tin := len(x)
	Tout := (Tin+2*padding-kernel)/stride + 1
	patches := make([][]float32, Tout)
	for to := 0; to < Tout; to++ {
		vec := make([]float32, inCh*kernel)
		start := to*stride - padding
		for k := 0; k < kernel; k++ {
			pos := start + k
			if pos < 0 || pos >= Tin {
				continue // leaves this kernel tap's inCh slots zero (zero padding)
			}
			row := x[pos]
			for ic := 0; ic < inCh; ic++ {
				vec[ic*kernel+k] = row[ic]
			}
		}
		patches[to] = vec
	}
	out := denseForward(patches, weight, bias, inCh*kernel, outCh, nil)
	geluExactInPlace(out)
	return out
}

// encoderLayer runs one pre-norm block (attention sub-layer + MLP
// sub-layer, each with its own residual) — matches
// WhisperEncoderLayer.forward. Reuses siglipLayerNorm (vision_siglip.go,
// generic over eps) with Whisper's own LayerNormEps (1e-5, NOT SigLIP2's
// 1e-6).
func (m *WhisperEncoderTower) encoderLayer(layer *whisperEncoderLayer, x [][]float32) [][]float32 {
	cfg := m.Cfg
	normed1 := siglipLayerNorm(x, layer.LN1Weight, layer.LN1Bias, cfg.LayerNormEps)
	attnOut := whisperAttention(layer, normed1, cfg)
	resid1 := addRows(x, attnOut)

	normed2 := siglipLayerNorm(resid1, layer.LN2Weight, layer.LN2Bias, cfg.LayerNormEps)
	mlpOut := whisperMLP(layer, normed2, cfg)
	return addRows(resid1, mlpOut)
}

// whisperAttention runs bidirectional (non-causal) multi-head
// self-attention over the whole sequence — matches WhisperAttention.forward
// with no attention_mask (every encoder frame, including any silence the
// feature extractor zero-padded, attends to every other frame — see file
// doc comment). Structurally identical to vision_siglip.go's
// siglipAttention CPU path (same softmax/weighted-sum reduction in
// float64, same bitnetParallelFor row-parallelism, same rationale — see
// that function's doc comment); duplicated rather than shared because the
// two operate on different layer/config types and this file has no GPU
// hook to thread through.
func whisperAttention(layer *whisperEncoderLayer, xNormed [][]float32, cfg WhisperEncoderConfig) [][]float32 {
	T := len(xNormed)
	hidden := cfg.Hidden
	heads := cfg.NumHeads
	hd := cfg.headDim()

	Q := denseForward(xNormed, layer.QWeight, layer.QBias, hidden, hidden, nil)
	K := denseForward(xNormed, layer.KWeight, layer.KBias, hidden, hidden, nil)
	V := denseForward(xNormed, layer.VWeight, layer.VBias, hidden, hidden, nil)

	scale := float32(1.0 / math.Sqrt(float64(hd)))
	out := make([][]float32, T)
	for t := range out {
		out[t] = make([]float32, hidden)
	}

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

	return denseForward(out, layer.OWeight, layer.OBias, hidden, hidden, nil)
}

// whisperMLP computes fc2(gelu_exact(fc1(x))) — matches
// WhisperEncoderLayer.forward with activation_function="gelu" (the exact
// erf variant — NOT gelu_pytorch_tanh, which vision_siglip.go's own
// siglipMLP uses for the unrelated SigLIP2 tower).
func whisperMLP(layer *whisperEncoderLayer, x [][]float32, cfg WhisperEncoderConfig) [][]float32 {
	h := denseForward(x, layer.FC1Weight, layer.FC1Bias, cfg.Hidden, cfg.Intermediate, nil)
	geluExactInPlace(h)
	return denseForward(h, layer.FC2Weight, layer.FC2Bias, cfg.Intermediate, cfg.Hidden, nil)
}

// ─────────────────────────────────────────────────────────────────────
// real_frame_count / stack_frames (audio_adapter.py's token-reduction op)
// ─────────────────────────────────────────────────────────────────────

// whisperMelHopSeconds / whisperEncoderStride are the Whisper mel
// front-end + encoder downsampling constants shared by every openai/
// whisper-* checkpoint (and this package's random-tiny fixture), matching
// forge/multimodal/audio_adapter.py's own _WHISPER_MEL_HOP_SECONDS /
// _WHISPER_ENCODER_STRIDE module constants exactly — see RealFrameCount's
// doc comment.
const (
	whisperMelHopSeconds = 0.01
	whisperEncoderStride = 2
)

// RealFrameCount mirrors forge/multimodal/audio_adapter.real_frame_count
// exactly: the real (unpadded) Whisper encoder frame count for a clip of
// nSamples raw audio samples at samplingRate Hz — ceil(seconds*50),
// capped to maxFrames (the encoder's own MaxSourcePositions) and floored
// at 1 so a degenerate zero-length clip still stacks into exactly one
// (all-zero-ish) token rather than none. 50 = (1/whisperMelHopSeconds) /
// whisperEncoderStride — holds for every whisper-*/random-tiny encoder
// (see audio_adapter.py's module docstring for why).
func RealFrameCount(nSamples, samplingRate, maxFrames int) int {
	framesPerSecond := (1.0 / whisperMelHopSeconds) / whisperEncoderStride
	seconds := float64(nSamples) / float64(samplingRate)
	n := int(math.Ceil(seconds * framesPerSecond))
	if n < 1 {
		n = 1
	}
	if n > maxFrames {
		n = maxFrames
	}
	return n
}

// StackFrames mirrors forge/multimodal/audio_adapter.stack_frames exactly:
// [T][C] encoder frames -> [ceil(T/k)][k*C], concatenating each
// contiguous run of k consecutive frames along the feature dim in
// CHRONOLOGICAL order (frame 0, the earliest of the group, occupies
// feature columns [0,C); frame k-1 occupies [(k-1)*C,k*C)) — zero-pads T
// up to a multiple of k first (trailing pad) if it doesn't already divide
// evenly, so only the LAST stacked token is ever diluted by padding
// frames, never any other token. Returns nil for an empty input.
func StackFrames(x [][]float32, k int) [][]float32 {
	T := len(x)
	if T == 0 {
		return nil
	}
	c := len(x[0])
	numTok := (T + k - 1) / k
	out := make([][]float32, numTok)
	for j := 0; j < numTok; j++ {
		vec := make([]float32, k*c)
		for i := 0; i < k; i++ {
			idx := j*k + i
			if idx >= T {
				break // leaves this (and every later) slot's C features zero
			}
			copy(vec[i*c:(i+1)*c], x[idx])
		}
		out[j] = vec
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// Projector
// ─────────────────────────────────────────────────────────────────────

// AudioProjector is the trainable 2-layer MLP (Linear -> GELU(exact) ->
// Linear) that maps stacked encoder tokens (len In = audio_hidden*
// stack_factor, e.g. 768*8=6144 for whisper-small at stack_factor 8) to
// LLM-hidden-sized audio embeddings (len Out, e.g. 2560) — matches
// AudioAdapter.projector (forge/multimodal/audio_adapter.py:
// `nn.Sequential(nn.Linear(proj_in, mlp_hidden), nn.GELU(), nn.Linear(mlp_hidden, llm_hidden))`,
// plain nn.GELU() — exact erf, same as SiglipProjector's). Structurally
// identical to vision_siglip.go's SiglipProjector; kept as its own named
// type (not a shared generic) so the eyes/ears public APIs stay
// independent, per this package's existing per-modality file layout.
type AudioProjector struct {
	In, Mlp, Out int
	FC1Weight    []float32 // [In,Mlp]
	FC1Bias      []float32 // [Mlp]
	FC2Weight    []float32 // [Mlp,Out]
	FC2Bias      []float32 // [Out]
}

// Forward runs fc2(gelu_exact(fc1(x))) for every row of x (each row: one
// stacked audio token, len p.In) and returns len(x) rows of len p.Out.
func (p *AudioProjector) Forward(x [][]float32) [][]float32 {
	h := denseForward(x, p.FC1Weight, p.FC1Bias, p.In, p.Mlp, nil)
	geluExactInPlace(h)
	return denseForward(h, p.FC2Weight, p.FC2Bias, p.Mlp, p.Out, nil)
}
