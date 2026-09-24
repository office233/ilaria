package cortex

// audio_whisper_test.go — the contract between the real `transformers`
// Whisper encoder + forge/multimodal's log-mel front end/stack_frames/
// projector and this package's Go implementation (audio_whisper.go,
// audio_whisper_persist.go, audio_wav.go).
//
// TestStackFramesHandComputed, TestRealFrameCount and
// TestConv1dGeluForwardHandComputed always run (no fixtures needed).
//
// TestWhisperEquivalence (real openai/whisper-small) and
// TestWhisperTinySynthetic (a random, undownloaded tiny encoder) are both
// skipped unless NEXUS_EARS_DIR (an absolute path) is set to a directory
// containing the files forge/multimodal/export_whisper_tower.py and
// forge/multimodal/dump_audio_reference.py produce:
//
//	whisper_small_encoder.nxtf + audio_reference.json + its *.bin
//	  sidecars + test_tone.wav + projector_seed42.safetensors/.json
//	whisper_tiny_encoder.nxtf + audio_reference_tiny.json + its *.bin
//	  sidecars + test_tone_tiny.wav + projector_seed42_tiny.safetensors/.json
//
// produced by:
//
//	python forge/multimodal/export_whisper_tower.py --out data/forge/ears/whisper_small_encoder.nxtf
//	python forge/multimodal/dump_audio_reference.py --out data/forge/ears/audio_reference.json
//	python forge/multimodal/export_whisper_tower.py --tiny --out data/forge/ears/whisper_tiny_encoder.nxtf
//	python forge/multimodal/dump_audio_reference.py --tiny --out data/forge/ears/audio_reference_tiny.json
//
// Tolerances (maxWhisperAbsTol/maxWhisperRelL2Tol below) were set from
// what this float64-accumulating port actually measures against the real
// whisper-small checkpoint (see TestWhisperEquivalence's t.Logf output,
// captured in README.md's "Ears" section) — same methodology
// cortex/vision_siglip_test.go's TestSigLIPEquivalence uses for its own
// 2e-3/1e-4 bounds: PyTorch's CPU GEMM/softmax/LayerNorm/STFT kernels use
// blocked/SIMD reductions whose summation order differs from this file's
// straightforward float64-accumulating loops, so exact (float32-ULP)
// agreement is not the bar — bounded drift through a 12-layer transformer
// (and, here, an additional from-scratch STFT front end) is.
//
// readFloat32Bin, flatten and maxAbsAndRelL2 are reused directly from
// vision_siglip_test.go (same package, same test binary — no need to
// duplicate them here).

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────────────
// Always-on unit tests: StackFrames / RealFrameCount / conv1d
// ─────────────────────────────────────────────────────────────────────

// TestStackFramesHandComputed mirrors
// forge/multimodal/tests/test_audio_adapter.py's StackFramesTests exactly
// (same input values, same expected chronological-concatenation output),
// cross-checked against forge/multimodal/audio_adapter.stack_frames
// directly.
func TestStackFramesHandComputed(t *testing.T) {
	t.Run("exact multiple, no padding", func(t *testing.T) {
		x := [][]float32{{0, 0}, {1, 1}, {2, 2}, {3, 3}} // [4,2], k=2 -> [2,4]
		got := StackFrames(x, 2)
		want := [][]float32{{0, 0, 1, 1}, {2, 2, 3, 3}}
		assertRowsEqual(t, got, want)
	})
	t.Run("pads to multiple with zeros", func(t *testing.T) {
		x := [][]float32{{0, 0}, {1, 1}, {2, 2}, {3, 3}, {4, 4}} // [5,2], k=2 -> [3,4], last token zero-padded
		got := StackFrames(x, 2)
		want := [][]float32{{0, 0, 1, 1}, {2, 2, 3, 3}, {4, 4, 0, 0}}
		assertRowsEqual(t, got, want)
	})
	t.Run("stacked token count matches formula", func(t *testing.T) {
		for _, tc := range []struct{ t, k int }{{50, 8}, {100, 8}, {1, 8}, {16, 4}, {17, 4}} {
			x := make([][]float32, tc.t)
			for i := range x {
				x[i] = []float32{float32(i), float32(i), float32(i)}
			}
			got := StackFrames(x, tc.k)
			want := (tc.t + tc.k - 1) / tc.k
			if len(got) != want {
				t.Errorf("t=%d k=%d: got %d tokens, want %d", tc.t, tc.k, len(got), want)
			}
			if len(got) > 0 && len(got[0]) != tc.k*3 {
				t.Errorf("t=%d k=%d: token width %d, want %d", tc.t, tc.k, len(got[0]), tc.k*3)
			}
		}
	})
}

func assertRowsEqual(t *testing.T, got, want [][]float32) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d (got=%v want=%v)", len(got), len(want), got, want)
	}
	for i := range want {
		if len(got[i]) != len(want[i]) {
			t.Fatalf("row %d: got len %d, want %d", i, len(got[i]), len(want[i]))
		}
		for j := range want[i] {
			if got[i][j] != want[i][j] {
				t.Errorf("row %d[%d]: got %v, want %v (full got=%v want=%v)", i, j, got[i][j], want[i][j], got, want)
			}
		}
	}
}

// TestRealFrameCount mirrors
// forge/multimodal/tests/test_audio_adapter.py's RealFrameCountTests.
func TestRealFrameCount(t *testing.T) {
	if got := RealFrameCount(16000, 16000, 1500); got != 50 {
		t.Errorf("1s @ 16kHz: got %d, want 50", got)
	}
	if got := RealFrameCount(16000*60, 16000, 100); got != 100 {
		t.Errorf("60s capped at max_frames=100: got %d, want 100", got)
	}
	if got := RealFrameCount(0, 16000, 100); got != 1 {
		t.Errorf("0 samples floors at 1: got %d, want 1", got)
	}
	// 3s @ 16kHz, whisper-small's real max_source_positions=1500 -> 150, uncapped.
	if got := RealFrameCount(3*16000, 16000, 1500); got != 150 {
		t.Errorf("3s @ 16kHz: got %d, want 150", got)
	}
}

// TestConv1dGeluForwardHandComputed checks conv1dGeluForward's im2col +
// GELU against a hand-computed single-channel, kernel=3/stride=1/pad=1
// example where the zero-padding at both boundaries is directly
// checkable: input [1,2,3,4] (T=4, inCh=1), identity-ish weight
// [0,1,0] (i.e. out = gelu(x[t])), zero bias -> output length 4,
// values gelu(1),gelu(2),gelu(3),gelu(4) (boundary padding contributes
// zero, and the [0,1,0] kernel ignores neighbors, isolating the
// padding-vs-center-tap indexing rather than exercising the padding
// value itself — see the stride=2 sub-test below for that).
func TestConv1dGeluForwardHandComputed(t *testing.T) {
	x := [][]float32{{1}, {2}, {3}, {4}}
	weight := []float32{0, 1, 0} // [inCh*kernel=3, outCh=1], flattened (inCh outer, kernel inner) — single channel
	bias := []float32{0}
	got := conv1dGeluForward(x, weight, bias, 1, 1, 3, 1, 1, nil)
	if len(got) != 4 {
		t.Fatalf("got %d output positions, want 4", len(got))
	}
	for i, v := range []float32{1, 2, 3, 4} {
		want := geluExactScalar(v)
		if math.Abs(float64(got[i][0]-want)) > 1e-6 {
			t.Errorf("pos %d: got %v, want gelu(%v)=%v", i, got[i][0], v, want)
		}
	}

	t.Run("stride 2 halves length and sums the zero-padded edge correctly", func(t *testing.T) {
		// weight=[1,0,0] picks up the LEFT-neighbor kernel tap (k=0):
		// out[to] = gelu(x[to*stride-padding]) when that index is in
		// range, else gelu(0) (the zero pad). At stride=2, pad=1: to=0 ->
		// index -1 (out of range) -> gelu(0)=0; to=1 -> index 1 -> x[1]=2
		// -> gelu(2). (x[0]=1 is never read by this tap/stride/padding
		// combination — it would need k=-1, which doesn't exist — so this
		// deliberately checks the padding boundary, not x[0] specifically.)
		x := [][]float32{{1}, {2}, {3}, {4}}
		weight := []float32{1, 0, 0}
		got := conv1dGeluForward(x, weight, bias, 1, 1, 3, 2, 1, nil)
		if len(got) != 2 {
			t.Fatalf("got %d output positions, want 2 (Tout=(4+2-3)/2+1=2)", len(got))
		}
		if got[0][0] != 0 {
			t.Errorf("out[0]: got %v, want gelu(0)=0 (left padding tap)", got[0][0])
		}
		want1 := geluExactScalar(2)
		if math.Abs(float64(got[1][0]-want1)) > 1e-6 {
			t.Errorf("out[1]: got %v, want gelu(2)=%v", got[1][0], want1)
		}
	})
}

func geluExactScalar(v float32) float32 {
	const invSqrt2 = 0.70710678118654752440
	return 0.5 * v * (1 + float32(math.Erf(float64(v)*invSqrt2)))
}

// ─────────────────────────────────────────────────────────────────────
// Real-checkpoint / synthetic-tiny equivalence (NEXUS_EARS_DIR)
// ─────────────────────────────────────────────────────────────────────

type audioRefStage struct {
	Shape   []int     `json:"shape"`
	BinPath string    `json:"bin_path"`
	Mean    float64   `json:"mean"`
	Std     float64   `json:"std"`
	First64 []float64 `json:"first64,omitempty"`
}

type audioRefFile struct {
	Audio struct {
		Path         string  `json:"path"`
		SamplingRate int     `json:"sampling_rate"`
		NumSamples   int     `json:"num_samples"`
		Seconds      float64 `json:"seconds"`
	} `json:"audio"`
	RealFrameCount     int                      `json:"real_frame_count"`
	MaxSourcePositions int                      `json:"max_source_positions"`
	StackFactor        int                      `json:"stack_factor"`
	AudioHidden        int                      `json:"audio_hidden"`
	LogMel             audioRefStage            `json:"log_mel"`
	ConvOutput         audioRefStage            `json:"conv_output"`
	HiddenLayers       map[string]audioRefStage `json:"hidden_layers"`
	FinalOutput        audioRefStage            `json:"final_output"`
	StackedTokens      audioRefStage            `json:"stacked_tokens"`
	ProjectorPrefix    string                   `json:"projector_prefix"`
	Projector          struct {
		Shape  []int       `json:"shape"`
		Values [][]float64 `json:"values"`
	} `json:"projector"`
}

// Empirically measured against the real openai/whisper-small checkpoint
// (TestWhisperEquivalence's own t.Logf output — reproduced in README.md's
// "Ears" section): log-mel max|Δ| over the first64 sample ≈ 1.18e-3;
// conv_output/hidden_layer_0/_5 max|Δ| ≈ 0.01-0.012 (relL2 ≈ 1.4-1.6e-4);
// hidden_layer_11/final_output/stacked_tokens max|Δ| ≈ 0.06-0.08 while
// relL2 stays ≈ 1-4.4e-4 the whole way through — i.e. the absolute error
// grows markedly over the last several layers but stays a tiny fraction
// of the activation vector's own norm throughout. This matches the
// "massive activation" outlier-channel phenomenon vision_siglip.go's own
// doc comment calls out for SigLIP2 (a handful of fixed channels carry
// activations orders of magnitude larger than the rest of the vector, so
// a fixed absolute float64-vs-PyTorch-GEMM rounding difference on THOSE
// channels dominates max|Δ| while barely moving relL2) — not a
// correctness bug: relL2, the more meaningful aggregate metric for a
// 768-wide vector, never exceeds ~1.4e-3 at any stage, including the
// projector. whisperMaxAbsTol is set with headroom above the worst
// observed max|Δ| (≈0.076); whisperRelL2Tol and whisperLogMelTol keep a
// much tighter margin, since those metrics are not outlier-dominated.
const (
	whisperMaxAbsTol = 0.12
	whisperRelL2Tol  = 2e-3
	whisperLogMelTol = 2e-3
)

// TestWhisperEquivalence checks the real openai/whisper-small encoder
// against forge/multimodal's PyTorch reference (see file doc comment for
// how to produce NEXUS_EARS_DIR's contents). Skipped unless that env var
// is set.
func TestWhisperEquivalence(t *testing.T) {
	dir := os.Getenv("NEXUS_EARS_DIR")
	if dir == "" {
		t.Skip("NEXUS_EARS_DIR not set — skipping real-checkpoint Whisper equivalence test")
	}
	runWhisperEquivalence(t, dir, "audio_reference.json", "whisper_small_encoder.nxtf")
}

// TestWhisperTinySynthetic runs the same equivalence chain against a
// random, undownloaded tiny encoder (forge/multimodal/audio_adapter.py's
// `_build_tiny_encoder`, exported by
// `export_whisper_tower.py --tiny`) — exercises the exact same Go code
// path (LogMel, conv1d, attention, stack_frames, projector) without
// needing the real ~350MB whisper-small checkpoint, so it "runs without
// the real model" per the task spec — but still needs the small
// fixture files under NEXUS_EARS_DIR (never a bare relative "data/..."
// path — see AGENTS.md), so it shares that env var's skip-if-unset gate
// with TestWhisperEquivalence rather than running unconditionally.
func TestWhisperTinySynthetic(t *testing.T) {
	dir := os.Getenv("NEXUS_EARS_DIR")
	if dir == "" {
		t.Skip("NEXUS_EARS_DIR not set — skipping synthetic tiny-config Whisper equivalence test")
	}
	runWhisperEquivalence(t, dir, "audio_reference_tiny.json", "whisper_tiny_encoder.nxtf")
}

func runWhisperEquivalence(t *testing.T, dir, refJSONName, towerFileName string) {
	t.Helper()
	refPath := filepath.Join(dir, refJSONName)
	refRaw, err := os.ReadFile(refPath)
	if err != nil {
		t.Skipf("%s missing (%v) — see file doc comment for how to produce it", refPath, err)
	}
	var ref audioRefFile
	if err := json.Unmarshal(refRaw, &ref); err != nil {
		t.Fatalf("parse %s: %v", refPath, err)
	}

	towerPath := filepath.Join(dir, towerFileName)
	loadStart := time.Now()
	tower, err := LoadWhisperEncoderTower(towerPath)
	if err != nil {
		t.Fatalf("LoadWhisperEncoderTower(%s): %v", towerPath, err)
	}
	t.Logf("tower load: %s (mel_bins=%d hidden=%d layers=%d heads=%d max_source_positions=%d)",
		time.Since(loadStart), tower.Cfg.NumMelBins, tower.Cfg.Hidden, tower.Cfg.NumLayers, tower.Cfg.NumHeads, tower.Cfg.MaxSourcePositions)

	wavPath := filepath.Join(dir, ref.Audio.Path)
	wf, err := os.Open(wavPath)
	if err != nil {
		t.Fatalf("open %s: %v", wavPath, err)
	}
	samples, sampleRate, err := DecodeWAV(wf)
	wf.Close()
	if err != nil {
		t.Fatalf("decode wav %s: %v", wavPath, err)
	}
	if sampleRate != ref.Audio.SamplingRate {
		t.Fatalf("wav sample rate %d, want %d", sampleRate, ref.Audio.SamplingRate)
	}
	if len(samples) != ref.Audio.NumSamples {
		t.Fatalf("wav sample count %d, want %d", len(samples), ref.Audio.NumSamples)
	}

	// (a) log-mel front end
	logMelStart := time.Now()
	logMel := tower.LogMel(samples)
	logMelElapsed := time.Since(logMelStart)
	if len(ref.LogMel.Shape) != 2 || len(logMel) != ref.LogMel.Shape[0] || len(logMel[0]) != ref.LogMel.Shape[1] {
		t.Fatalf("log-mel shape %dx%d, want %v", len(logMel), len(logMel[0]), ref.LogMel.Shape)
	}
	worstLogMel := 0.0
	for i := 0; i < len(ref.LogMel.First64) && i < len(logMel[0]); i++ {
		// ref's "first64" is feats[0].flatten()[:64] over a [80,T] array
		// (numpy row-major) — since T > 64 for both fixtures, that's mel
		// bin 0's first 64 frames, i.e. logMel[0][:64] in this package's
		// own mel-major LogMel return shape (see that method's doc
		// comment).
		d := math.Abs(ref.LogMel.First64[i] - float64(logMel[0][i]))
		if d > worstLogMel {
			worstLogMel = d
		}
	}
	if worstLogMel > whisperLogMelTol {
		t.Errorf("log-mel: max|Δ| over first64 = %.3e (tol %.0e)", worstLogMel, whisperLogMelTol)
	} else {
		t.Logf("log-mel: max|Δ| over first64 = %.3e (tol %.0e), computed in %s (%dx%d)",
			worstLogMel, whisperLogMelTol, logMelElapsed, len(logMel), len(logMel[0]))
	}

	// (b) full encoder forward, capturing conv-output + every layer the
	// reference recorded.
	var captureLayers []int
	for k := range ref.HiddenLayers {
		i, err := strconv.Atoi(k)
		if err != nil {
			t.Fatalf("hidden_layers key %q: %v", k, err)
		}
		captureLayers = append(captureLayers, i)
	}
	sort.Ints(captureLayers)

	fwdStart := time.Now()
	final, convOut, captured := tower.ForwardDebug(logMel, captureLayers)
	fwdElapsed := time.Since(fwdStart)

	compareStage(t, dir, "conv_output", convOut, ref.ConvOutput)
	for _, i := range captureLayers {
		compareStage(t, dir, fmt.Sprintf("hidden_layer_%d", i), captured[i], ref.HiddenLayers[strconv.Itoa(i)])
	}
	compareStage(t, dir, "final_output", final, ref.FinalOutput)
	t.Logf("encoder forward: %s (%dx%d)", fwdElapsed, len(final), len(final[0]))

	// (c) real_frame_count
	gotFrames := RealFrameCount(ref.Audio.NumSamples, ref.Audio.SamplingRate, tower.Cfg.MaxSourcePositions)
	if gotFrames != ref.RealFrameCount {
		t.Errorf("RealFrameCount: got %d, want %d", gotFrames, ref.RealFrameCount)
	}

	// (d) crop + stack_frames
	cropped := final[:gotFrames]
	stacked := StackFrames(cropped, ref.StackFactor)
	compareStage(t, dir, "stacked_tokens", stacked, ref.StackedTokens)

	// (e) projector round-trip: load the exported random-weight
	// projector and run it on THIS package's own computed stacked
	// tokens, checking against the PyTorch reference's projector output
	// on the (numerically equivalent) same tensor — a genuine end-to-end
	// chain, mirroring vision_siglip_test.go's TestSigLIPEquivalence part (d).
	proj, err := LoadAudioProjector(filepath.Join(dir, ref.ProjectorPrefix))
	if err != nil {
		t.Fatalf("LoadAudioProjector(%s): %v", ref.ProjectorPrefix, err)
	}
	if proj.In != len(stacked[0]) {
		t.Fatalf("projector.In=%d, stacked token width=%d", proj.In, len(stacked[0]))
	}
	projected := proj.Forward(stacked)
	if len(ref.Projector.Values) != len(projected) {
		t.Fatalf("projector: got %d rows, want %d", len(projected), len(ref.Projector.Values))
	}
	projMaxAbs := 0.0
	for i := range projected {
		if len(ref.Projector.Values[i]) != len(projected[i]) {
			t.Fatalf("projector row %d: got %d dims, want %d", i, len(projected[i]), len(ref.Projector.Values[i]))
		}
		for j := range projected[i] {
			d := math.Abs(ref.Projector.Values[i][j] - float64(projected[i][j]))
			if d > projMaxAbs {
				projMaxAbs = d
			}
		}
	}
	if projMaxAbs > whisperMaxAbsTol {
		t.Errorf("projector: max|Δ| = %.3e (tol %.0e)", projMaxAbs, whisperMaxAbsTol)
	} else {
		t.Logf("projector: max|Δ| = %.3e (tol %.0e), shape %dx%d", projMaxAbs, whisperMaxAbsTol, len(projected), len(projected[0]))
	}
}

// compareStage checks got against a reference stage's full tensor
// (loaded from its .bin sidecar via readFloat32Bin, shared with
// vision_siglip_test.go) using max|Δ| and relative L2 — same metric pair
// TestSigLIPEquivalence's tower check uses, and the same tolerances for
// every stage here (see whisperMaxAbsTol/whisperRelL2Tol's doc comment).
func compareStage(t *testing.T, dir, label string, got [][]float32, stage audioRefStage) {
	t.Helper()
	if len(stage.Shape) != 2 || len(got) != stage.Shape[0] || (len(got) > 0 && len(got[0]) != stage.Shape[1]) {
		gotCols := 0
		if len(got) > 0 {
			gotCols = len(got[0])
		}
		t.Fatalf("%s: shape %dx%d, want %v", label, len(got), gotCols, stage.Shape)
	}
	gotFlat := flatten(got)
	want, err := readFloat32Bin(filepath.Join(dir, stage.BinPath), len(gotFlat))
	if err != nil {
		t.Fatalf("%s: read %s: %v", label, stage.BinPath, err)
	}
	wantF64 := make([]float64, len(want))
	for i, v := range want {
		wantF64[i] = float64(v)
	}
	maxAbs, relL2 := maxAbsAndRelL2(wantF64, gotFlat)
	if maxAbs > whisperMaxAbsTol || relL2 > whisperRelL2Tol {
		t.Errorf("%s: max|Δ|=%.3e (tol %.0e) relL2=%.3e (tol %.0e)", label, maxAbs, whisperMaxAbsTol, relL2, whisperRelL2Tol)
	} else {
		t.Logf("%s: max|Δ|=%.3e relL2=%.3e (%dx%d)", label, maxAbs, relL2, len(got), len(got[0]))
	}
}
