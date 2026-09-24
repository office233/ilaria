//go:build gpu

package cortex

// vision_siglip_gpu_test.go — GPU-vs-CPU equivalence for the resident
// fp32 cuBLAS tower backend (vision_siglip_gpu.go). Uses the same
// NEXUS_EYES_DIR fixture and shared helpers (flatten, maxAbsAndRelL2,
// readFloat32Bin, visionRefFile) as TestSigLIPEquivalence
// (vision_siglip_test.go) — both files are package cortex, so the test
// binary sees them together whenever this file's `gpu` tag is set.
//
// The end-to-end cmd/ilaria-see -gpu caption check (test_cat.jpg /
// test_photo.jpg vs the known CPU captions) is run as an actual binary
// invocation rather than duplicated here as Go code — see the task's
// final report for that run's output — since "semantically identical
// caption, small wording differences acceptable" is a judgment call, not
// something a numeric Go assertion should encode.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nexus-cortex/cortex/compute"
)

// TestSiglipGPUTowerMatchesCPU runs the tower once on the CPU and once
// with EnableSiglipGPU attached (same tower instance, same
// preprocessed pixel values), then reports max|Δ| and relative L2
// between the two — both against each other and, to rule out a
// GPU-and-CPU-both-wrong coincidence, against the PyTorch reference
// tensor TestSigLIPEquivalence itself checks. Finally re-runs
// PixelShuffle + the projector on the GPU tower's output and checks it
// stays within the same 2e-3 abs tolerance TestSigLIPEquivalence uses
// for the CPU path, per the task's numerics requirement. Skipped unless
// NEXUS_EYES_DIR is set and a CUDA device/driver is present.
func TestSiglipGPUTowerMatchesCPU(t *testing.T) {
	dir := os.Getenv("NEXUS_EYES_DIR")
	if dir == "" {
		t.Skip("NEXUS_EYES_DIR not set — skipping GPU tower equivalence test")
	}
	if err := compute.InitCuBLAS(); err != nil {
		t.Skipf("cuda not available: %v", err)
	}

	refRaw, err := os.ReadFile(filepath.Join(dir, "vision_ref.json"))
	if err != nil {
		t.Fatalf("read vision_ref.json: %v", err)
	}
	var ref visionRefFile
	if err := json.Unmarshal(refRaw, &ref); err != nil {
		t.Fatalf("parse vision_ref.json: %v", err)
	}

	towerPath := filepath.Join(dir, "siglip2_base.nxtf")
	tower, err := LoadSiglipVisionTower(towerPath)
	if err != nil {
		t.Fatalf("LoadSiglipVisionTower(%s): %v", towerPath, err)
	}

	imgPath := ref.Image.Path
	if !filepath.IsAbs(imgPath) {
		imgPath = filepath.Join(dir, imgPath)
	}
	f, err := os.Open(imgPath)
	if err != nil {
		t.Fatalf("open image %s: %v", imgPath, err)
	}
	img, _, err := DecodeImage(f)
	f.Close()
	if err != nil {
		t.Fatalf("decode image %s: %v", imgPath, err)
	}
	pixelValues := PreprocessImage(img, tower.Cfg.ImageSize)

	cpuStart := time.Now()
	cpuHidden := tower.Forward(pixelValues)
	cpuElapsed := time.Since(cpuStart)

	if err := EnableSiglipGPU(tower); err != nil {
		t.Skipf("EnableSiglipGPU: %v", err)
	}
	defer DisableSiglipGPU(tower)

	gpuStart := time.Now()
	gpuHidden := tower.Forward(pixelValues)
	gpuElapsed := time.Since(gpuStart)

	cpuFlat := flatten(cpuHidden)
	gpuFlat := flatten(gpuHidden)
	cpuFlatF64 := make([]float64, len(cpuFlat))
	for i, v := range cpuFlat {
		cpuFlatF64[i] = float64(v)
	}
	selfMaxAbs, selfRelL2 := maxAbsAndRelL2(cpuFlatF64, gpuFlat)
	t.Logf("tower GPU vs CPU (this machine): max|Δ|=%.3e relL2=%.3e | CPU forward=%s GPU forward=%s",
		selfMaxAbs, selfRelL2, cpuElapsed, gpuElapsed)

	hiddenRef, err := readFloat32Bin(filepath.Join(dir, ref.Tower.BinPath), len(gpuFlat))
	if err != nil {
		t.Fatalf("read %s: %v", ref.Tower.BinPath, err)
	}
	hiddenRefF64 := make([]float64, len(hiddenRef))
	for i, v := range hiddenRef {
		hiddenRefF64[i] = float64(v)
	}
	refMaxAbs, refRelL2 := maxAbsAndRelL2(hiddenRefF64, gpuFlat)
	t.Logf("tower GPU vs PyTorch reference: max|Δ|=%.3e relL2=%.3e", refMaxAbs, refRelL2)

	// The projector's own tolerance (TestSigLIPEquivalence) is 2e-3 abs
	// against the PyTorch reference; feeding it the GPU tower's output
	// instead of the CPU tower's checks that the fp32-accumulation
	// deviation measured above doesn't blow that budget once pixel
	// shuffle's 9x channel concatenation and the projector's two Linear
	// layers touch it.
	shuffled := PixelShuffle(gpuHidden, tower.Cfg.gridSide(), 3)
	adapterPrefix := ref.AdapterPrefix
	if adapterPrefix == "" {
		adapterPrefix = "projector_seed42"
	}
	proj, err := LoadSiglipProjector(filepath.Join(dir, adapterPrefix))
	if err != nil {
		t.Fatalf("LoadSiglipProjector(%s): %v", adapterPrefix, err)
	}
	projected := proj.Forward(shuffled)
	if len(ref.Projector.Values) != len(projected) {
		t.Fatalf("projector: got %d rows, want %d", len(projected), len(ref.Projector.Values))
	}
	projMaxAbs := 0.0
	for i := range projected {
		for j := range projected[i] {
			d := math.Abs(ref.Projector.Values[i][j] - float64(projected[i][j]))
			if d > projMaxAbs {
				projMaxAbs = d
			}
		}
	}
	const projMaxAbsTol = 2e-3
	if projMaxAbs > projMaxAbsTol {
		t.Errorf("projector (fed by GPU tower): max|Δ| = %.3e (tol %.0e)", projMaxAbs, projMaxAbsTol)
	} else {
		t.Logf("projector (fed by GPU tower): max|Δ| = %.3e (tol %.0e)", projMaxAbs, projMaxAbsTol)
	}
}
