//go:build gpu

package cortex

// audio_whisper_gpu_test.go — GPU-vs-CPU equivalence for the resident
// fp32 cuBLAS Whisper encoder backend (audio_whisper_gpu.go). Uses the
// same NEXUS_EARS_DIR fixtures and shared helpers (audioRefFile,
// compareStage, flatten, maxAbsAndRelL2, readFloat32Bin, whisperMaxAbsTol/
// whisperRelL2Tol) as TestWhisperEquivalence/TestWhisperTinySynthetic
// (audio_whisper_test.go) — both files are package cortex, so the test
// binary sees them together whenever this file's `gpu` tag is set.
//
// The end-to-end cmd/ilaria-hear -gpu run (real_frames/stacked-token
// count, tower time CPU vs GPU) is run as an actual binary invocation
// rather than duplicated here as Go code — see the task's final report
// for that run's output — same split vision_siglip_gpu_test.go's own
// doc comment describes for cmd/ilaria-see -gpu.

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

	"nexus-cortex/cortex/compute"
)

// TestWhisperGPUTowerMatchesCPU runs the real openai/whisper-small
// encoder once on the CPU and once with EnableWhisperGPU attached (same
// tower instance, same log-mel input computed once), logging max|Δ|/
// relL2 at every captured stage (conv output, every hidden layer the
// reference recorded, final output) both against each other (this
// machine's own GPU-vs-CPU deviation) and against the PyTorch reference
// tensors TestWhisperEquivalence itself checks — via compareStage,
// reused unchanged, so the GPU path is held to the exact SAME
// whisperMaxAbsTol/whisperRelL2Tol bounds the CPU path is. Finally
// re-runs RealFrameCount + StackFrames + the projector on the GPU
// tower's own output and checks it stays within whisperMaxAbsTol too,
// per the task's numerics requirement. Also logs CPU-vs-GPU forward
// timing on the same input. Skipped unless NEXUS_EARS_DIR is set and a
// CUDA device/driver is present.
func TestWhisperGPUTowerMatchesCPU(t *testing.T) {
	runWhisperGPUEquivalence(t, "audio_reference.json", "whisper_small_encoder.nxtf")
}

// TestWhisperGPUTinySynthetic runs the identical GPU/CPU equivalence
// chain against the random, undownloaded tiny encoder fixture (the GPU
// counterpart to TestWhisperTinySynthetic) — exercises the same Go code
// path (conv1d, attention, stack_frames, projector) on the GPU backend
// without needing the real ~350 MB whisper-small checkpoint.
func TestWhisperGPUTinySynthetic(t *testing.T) {
	runWhisperGPUEquivalence(t, "audio_reference_tiny.json", "whisper_tiny_encoder.nxtf")
}

func runWhisperGPUEquivalence(t *testing.T, refJSONName, towerFileName string) {
	t.Helper()
	dir := os.Getenv("NEXUS_EARS_DIR")
	if dir == "" {
		t.Skip("NEXUS_EARS_DIR not set — skipping GPU tower equivalence test")
	}
	if err := compute.InitCuBLAS(); err != nil {
		t.Skipf("cuda not available: %v", err)
	}

	refPath := filepath.Join(dir, refJSONName)
	refRaw, err := os.ReadFile(refPath)
	if err != nil {
		t.Skipf("%s missing (%v) — see audio_whisper_test.go's file doc comment for how to produce it", refPath, err)
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

	logMel := tower.LogMel(samples)

	var captureLayers []int
	for k := range ref.HiddenLayers {
		i, err := strconv.Atoi(k)
		if err != nil {
			t.Fatalf("hidden_layers key %q: %v", k, err)
		}
		captureLayers = append(captureLayers, i)
	}
	sort.Ints(captureLayers)

	// (a) CPU forward, timed and captured at the same stages the
	// reference recorded.
	cpuStart := time.Now()
	cpuFinal, cpuConv, cpuCaptured := tower.ForwardDebug(logMel, captureLayers)
	cpuElapsed := time.Since(cpuStart)

	// (b) attach the GPU backend and re-run the identical forward on
	// the identical input.
	gpuEnableStart := time.Now()
	if err := EnableWhisperGPU(tower); err != nil {
		t.Skipf("EnableWhisperGPU: %v", err)
	}
	defer DisableWhisperGPU(tower)
	t.Logf("EnableWhisperGPU: %s", time.Since(gpuEnableStart))

	gpuStart := time.Now()
	gpuFinal, gpuConv, gpuCaptured := tower.ForwardDebug(logMel, captureLayers)
	gpuElapsed := time.Since(gpuStart)

	speedup := "n/a"
	if gpuElapsed > 0 {
		speedup = fmt.Sprintf("%.2fx", cpuElapsed.Seconds()/gpuElapsed.Seconds())
	}
	t.Logf("%s: CPU forward=%s GPU forward=%s (speedup %s)", towerFileName, cpuElapsed, gpuElapsed, speedup)

	// This machine's own GPU-vs-CPU deviation at every captured stage
	// (float64 CPU accumulation vs cuBLAS fp32 accumulation — see
	// audio_whisper_gpu.go's file doc comment).
	logSelfDelta := func(label string, cpu, gpu [][]float32) {
		cpuFlat := flatten(cpu)
		gpuFlat := flatten(gpu)
		cpuFlatF64 := make([]float64, len(cpuFlat))
		for i, v := range cpuFlat {
			cpuFlatF64[i] = float64(v)
		}
		maxAbs, relL2 := maxAbsAndRelL2(cpuFlatF64, gpuFlat)
		t.Logf("%s %s: GPU vs CPU (this machine) max|Δ|=%.3e relL2=%.3e", towerFileName, label, maxAbs, relL2)
	}
	logSelfDelta("conv_output", cpuConv, gpuConv)
	for _, i := range captureLayers {
		logSelfDelta(fmt.Sprintf("hidden_layer_%d", i), cpuCaptured[i], gpuCaptured[i])
	}
	logSelfDelta("final_output", cpuFinal, gpuFinal)

	// GPU vs PyTorch reference — same helper, same tolerances as the
	// CPU-path test (TestWhisperEquivalence/TestWhisperTinySynthetic).
	compareStage(t, dir, "conv_output (GPU)", gpuConv, ref.ConvOutput)
	for _, i := range captureLayers {
		compareStage(t, dir, fmt.Sprintf("hidden_layer_%d (GPU)", i), gpuCaptured[i], ref.HiddenLayers[strconv.Itoa(i)])
	}
	compareStage(t, dir, "final_output (GPU)", gpuFinal, ref.FinalOutput)

	// (c)/(d) crop + stack_frames, fed by the GPU tower's own output.
	gotFrames := RealFrameCount(ref.Audio.NumSamples, ref.Audio.SamplingRate, tower.Cfg.MaxSourcePositions)
	if gotFrames != ref.RealFrameCount {
		t.Errorf("RealFrameCount: got %d, want %d", gotFrames, ref.RealFrameCount)
	}
	cropped := gpuFinal[:gotFrames]
	stacked := StackFrames(cropped, ref.StackFactor)
	compareStage(t, dir, "stacked_tokens (GPU)", stacked, ref.StackedTokens)

	// (e) projector round-trip, fed by the GPU tower's stacked tokens —
	// checks the fp32-accumulation deviation measured above doesn't
	// blow the projector's whisperMaxAbsTol budget once stack_frames'
	// 8x concatenation and the projector's two Linear layers touch it,
	// mirroring runWhisperEquivalence's own part (e).
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
		t.Errorf("%s: projector (fed by GPU tower): max|Δ| = %.3e (tol %.0e)", towerFileName, projMaxAbs, whisperMaxAbsTol)
	} else {
		t.Logf("%s: projector (fed by GPU tower): max|Δ| = %.3e (tol %.0e), shape %dx%d",
			towerFileName, projMaxAbs, whisperMaxAbsTol, len(projected), len(projected[0]))
	}
}
