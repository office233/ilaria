package cortex

// vision_siglip_test.go — the contract between the real `transformers`
// SigLIP2-base vision tower + forge/multimodal's pixel-shuffle/projector
// and this package's Go implementation (vision_siglip.go,
// vision_siglip_persist.go).
//
// TestPixelShuffleHandComputed and TestResizeBilinearRGBVsPIL always run
// (no fixtures needed beyond the tiny committed
// forge/fixtures/resize_bilinear_fixture.json).
//
// TestSigLIPEquivalence is skipped unless NEXUS_EYES_DIR (an absolute
// path) is set to a directory containing:
//
//	siglip2_base.nxtf         — forge/multimodal/export_tower.py
//	projector_seed42.safetensors/.json, OR a trained adapter's
//	  PREFIX.safetensors/.json — forge/multimodal/export_adapter.py
//	vision_ref.json + vision_ref_hidden.bin — forge/multimodal/dump_vision_reference.py
//	<image files the JSON's "image"."path" fields point at>
//
// produced by:
//
//	python forge/multimodal/export_tower.py --out data/forge/eyes/siglip2_base.nxtf
//	python forge/multimodal/dump_vision_reference.py --image <png> \
//	    --adapter data/forge/eyes/projector_seed42 --out data/forge/eyes/vision_ref.json

import (
	"encoding/binary"
	"encoding/json"
	"image"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────────────
// PixelShuffle
// ─────────────────────────────────────────────────────────────────────

// TestPixelShuffleHandComputed checks PixelShuffle against a hand-computed
// 2x2/s=2 example (no padding needed: side=2 is already a multiple of
// s=2), single channel, values chosen so the expected concatenation order
// is unambiguous to read off. Cross-checked against
// forge/multimodal/vision_adapter.pixel_shuffle directly:
//
//	>>> pixel_shuffle(torch.tensor([[[0.],[1.],[10.],[11.]]]), 2, 2, 2, "pad")
//	tensor([[[ 0.,  1., 10., 11.]]])
func TestPixelShuffleHandComputed(t *testing.T) {
	tokens := [][]float32{{0}, {1}, {10}, {11}} // grid (gy,gx): (0,0)=0 (0,1)=1 (1,0)=10 (1,1)=11
	got := PixelShuffle(tokens, 2, 2)
	want := [][]float32{{0, 1, 10, 11}}

	if len(got) != len(want) {
		t.Fatalf("PixelShuffle: got %d tokens, want %d", len(got), len(want))
	}
	for i := range want {
		if len(got[i]) != len(want[i]) {
			t.Fatalf("token %d: got len %d, want %d", i, len(got[i]), len(want[i]))
		}
		for j := range want[i] {
			if got[i][j] != want[i][j] {
				t.Errorf("token %d[%d]: got %v, want %v (full got=%v want=%v)", i, j, got[i][j], want[i][j], got, want)
			}
		}
	}
}

// TestPixelShuffleGridSideThirtyTwoShuffleThree checks the exact
// dimensions the real adapter uses (side=32 -> reduced_grid_side=11,
// tokens_per_image=121, per vision_adapter.py's grid_and_token_count) and
// that padding rows/columns (gy or gx >= 32) contribute zero, not garbage.
func TestPixelShuffleGridSideThirtyTwoShuffleThree(t *testing.T) {
	const side = 32
	const s = 3
	const c = 2
	tokens := make([][]float32, side*side)
	for gy := 0; gy < side; gy++ {
		for gx := 0; gx < side; gx++ {
			tokens[gy*side+gx] = []float32{float32(gy), float32(gx)}
		}
	}
	out := PixelShuffle(tokens, side, s)
	const rSide = 11 // ceil(32/3)
	if len(out) != rSide*rSide {
		t.Fatalf("got %d tokens, want %d", len(out), rSide*rSide)
	}
	for _, row := range out {
		if len(row) != s*s*c {
			t.Fatalf("token has %d dims, want %d", len(row), s*s*c)
		}
	}

	// Last block-row/column (I=10 or J=10) covers gy/gx in [30,33) —
	// position 32 falls in the zero-padded row, so its (si,sj)=(2,*) or
	// (*,2) slots must be exactly zero.
	lastBlock := out[(rSide-1)*rSide+(rSide-1)] // I=10, J=10 -> gy,gx in [30,33)
	// si=2 (gy=32, out of range) sj=0 (gx=30, in range) -> zero (gy out of range)
	off := (2*s + 0) * c
	if lastBlock[off] != 0 || lastBlock[off+1] != 0 {
		t.Errorf("padded row not zero: %v", lastBlock[off:off+2])
	}
	// si=0 (gy=30) sj=0 (gx=30) -> real value [30,30]
	off = (0*s + 0) * c
	if lastBlock[off] != 30 || lastBlock[off+1] != 30 {
		t.Errorf("real block value wrong: got %v, want [30 30]", lastBlock[off:off+2])
	}
}

// ─────────────────────────────────────────────────────────────────────
// Bilinear resize vs PIL
// ─────────────────────────────────────────────────────────────────────

type resizeBilinearFixture struct {
	SrcH      int       `json:"src_h"`
	SrcW      int       `json:"src_w"`
	DstH      int       `json:"dst_h"`
	DstW      int       `json:"dst_w"`
	SrcRGB    []float64 `json:"src_rgb"`
	DstRGBPil []float64 `json:"dst_rgb_pil"`
}

// TestResizeBilinearRGBVsPIL measures resizeBilinearRGB's deviation from
// PIL.Image.resize(..., resample=BILINEAR) on a genuine (non-identity)
// resize, using the committed reference fixture
// forge/fixtures/resize_bilinear_fixture.json (see PreprocessImage's doc
// comment for the accepted bound and why it doesn't block the tower
// equivalence check, which only ever resizes already-512x512 images).
func TestResizeBilinearRGBVsPIL(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "forge", "fixtures", "resize_bilinear_fixture.json"))
	if err != nil {
		t.Skipf("fixture missing (%v)", err)
	}
	var fx resizeBilinearFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}

	img := image.NewNRGBA(image.Rect(0, 0, fx.SrcW, fx.SrcH))
	for y := 0; y < fx.SrcH; y++ {
		for x := 0; x < fx.SrcW; x++ {
			srcIdx := (y*fx.SrcW + x) * 3
			po := y*img.Stride + x*4
			img.Pix[po] = uint8(fx.SrcRGB[srcIdx])
			img.Pix[po+1] = uint8(fx.SrcRGB[srcIdx+1])
			img.Pix[po+2] = uint8(fx.SrcRGB[srcIdx+2])
			img.Pix[po+3] = 255
		}
	}

	got := resizeBilinearRGB(img, fx.DstW, fx.DstH)

	const bound = 1.5 // measured max |Δ| ≈ 1.0/255 — see doc comment; some margin against fixture-specific rounding
	worst := 0.0
	for y := 0; y < fx.DstH; y++ {
		for x := 0; x < fx.DstW; x++ {
			dstIdx := (y*fx.DstW + x) * 3
			po := y*got.Stride + x*4
			for ch := 0; ch < 3; ch++ {
				want := fx.DstRGBPil[dstIdx+ch]
				gotV := float64(got.Pix[po+ch])
				d := math.Abs(want - gotV)
				if d > worst {
					worst = d
				}
				if d > bound {
					t.Errorf("(%d,%d) ch%d: got %v, want %v (|Δ|=%.2f > bound %.2f)", x, y, ch, gotV, want, d, bound)
				}
			}
		}
	}
	t.Logf("resizeBilinearRGB vs PIL BILINEAR: max|Δ| = %.3f/255 (bound %.2f)", worst, bound)
}

// ─────────────────────────────────────────────────────────────────────
// Real-checkpoint tower + projector equivalence (NEXUS_EYES_DIR)
// ─────────────────────────────────────────────────────────────────────

type visionRefFile struct {
	Image struct {
		Path          string `json:"path"`
		Width, Height int
	} `json:"image"`
	PixelValues struct {
		Shape   []int     `json:"shape"`
		First64 []float64 `json:"first64"`
	} `json:"pixel_values"`
	Tower struct {
		Shape   []int   `json:"shape"`
		BinPath string  `json:"bin_path"`
		Mean    float64 `json:"mean"`
		Std     float64 `json:"std"`
	} `json:"tower"`
	PixelShuffle struct {
		Shape []int `json:"shape"`
	} `json:"pixel_shuffle"`
	Projector struct {
		Shape  []int       `json:"shape"`
		Values [][]float64 `json:"values"`
	} `json:"projector"`
	AdapterPrefix string `json:"adapter_prefix"`
}

// readFloat32Bin reads a raw little-endian float32 array (dump_vision_reference.py's
// "bin_path" sidecar for the tower's full last_hidden_state — kept out of
// the JSON to avoid a 3MB+ text file; see that script's doc comment).
func readFloat32Bin(path string, n int) ([]float32, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(raw) != n*4 {
		return nil, os.ErrInvalid
	}
	out := make([]float32, n)
	for i := 0; i < n; i++ {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out, nil
}

func flatten(rows [][]float32) []float32 {
	if len(rows) == 0 {
		return nil
	}
	c := len(rows[0])
	out := make([]float32, 0, len(rows)*c)
	for _, r := range rows {
		out = append(out, r...)
	}
	return out
}

// maxAbsAndRelL2 compares two equal-length float slices (want as float64
// for JSON-sourced references, got as float32 from the Go engine) and
// returns max|Δ| and relative L2 (||want-got||_2 / ||want||_2).
func maxAbsAndRelL2(want []float64, got []float32) (maxAbs, relL2 float64) {
	var sumSqDiff, sumSqWant float64
	for i := range want {
		d := want[i] - float64(got[i])
		if a := math.Abs(d); a > maxAbs {
			maxAbs = a
		}
		sumSqDiff += d * d
		sumSqWant += want[i] * want[i]
	}
	if sumSqWant == 0 {
		return maxAbs, 0
	}
	return maxAbs, math.Sqrt(sumSqDiff / sumSqWant)
}

// TestSigLIPEquivalence checks the real google/siglip2-base-patch16-512
// tower and a projector adapter against forge/multimodal's PyTorch
// reference (see file doc comment for how to produce NEXUS_EYES_DIR's
// contents). Skipped unless that env var is set.
func TestSigLIPEquivalence(t *testing.T) {
	dir := os.Getenv("NEXUS_EYES_DIR")
	if dir == "" {
		t.Skip("NEXUS_EYES_DIR not set — skipping real-checkpoint SigLIP equivalence test")
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
	loadStart := time.Now()
	tower, err := LoadSiglipVisionTower(towerPath)
	if err != nil {
		t.Fatalf("LoadSiglipVisionTower(%s): %v", towerPath, err)
	}
	t.Logf("tower load: %s", time.Since(loadStart))

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

	// (a) preprocessing — compared against the PyTorch reference's first
	// 64 values. Both fixtures are synthesized at exactly tower.Cfg.ImageSize
	// (see PreprocessImage's doc comment), so resize is a no-op and this
	// should match to float32 precision (well under 1e-6).
	const preprocTol = 1e-6
	worstPre := 0.0
	n64 := len(ref.PixelValues.First64)
	if n64 > len(pixelValues) {
		n64 = len(pixelValues)
	}
	for i := 0; i < n64; i++ {
		d := math.Abs(ref.PixelValues.First64[i] - float64(pixelValues[i]))
		if d > worstPre {
			worstPre = d
		}
	}
	if worstPre > preprocTol {
		t.Errorf("preprocessing: max|Δ| over first 64 values = %.3e (tol %.0e)", worstPre, preprocTol)
	} else {
		t.Logf("preprocessing: max|Δ| over first 64 values = %.3e (tol %.0e)", worstPre, preprocTol)
	}

	// (b) tower forward
	fwdStart := time.Now()
	hidden := tower.Forward(pixelValues)
	fwdElapsed := time.Since(fwdStart)
	wantShape := ref.Tower.Shape
	if len(wantShape) != 2 || len(hidden) != wantShape[0] || len(hidden[0]) != wantShape[1] {
		t.Fatalf("tower output shape %dx%d, want %v", len(hidden), len(hidden[0]), wantShape)
	}
	hiddenFlat := flatten(hidden)
	hiddenRef, err := readFloat32Bin(filepath.Join(dir, ref.Tower.BinPath), len(hiddenFlat))
	if err != nil {
		t.Fatalf("read %s: %v", ref.Tower.BinPath, err)
	}
	hiddenRefF64 := make([]float64, len(hiddenRef))
	for i, v := range hiddenRef {
		hiddenRefF64[i] = float64(v)
	}
	towerMaxAbs, towerRelL2 := maxAbsAndRelL2(hiddenRefF64, hiddenFlat)
	const towerMaxAbsTol = 2e-3
	const towerRelL2Tol = 1e-4
	if towerMaxAbs > towerMaxAbsTol || towerRelL2 > towerRelL2Tol {
		t.Errorf("tower: max|Δ|=%.3e (tol %.0e) relL2=%.3e (tol %.0e)", towerMaxAbs, towerMaxAbsTol, towerRelL2, towerRelL2Tol)
	}
	t.Logf("tower: max|Δ|=%.3e relL2=%.3e, forward=%s (%dx%d)", towerMaxAbs, towerRelL2, fwdElapsed, len(hidden), len(hidden[0]))

	// (c) pixel shuffle shape sanity (no PyTorch reference values checked
	// here — the projector check below transitively covers correctness,
	// since it consumes this output directly).
	shuffled := PixelShuffle(hidden, tower.Cfg.gridSide(), 3)
	psShape := ref.PixelShuffle.Shape
	if len(psShape) == 2 && (len(shuffled) != psShape[0] || len(shuffled[0]) != psShape[1]) {
		t.Errorf("pixel_shuffle shape %dx%d, want %v", len(shuffled), len(shuffled[0]), psShape)
	}

	// (d) projector
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
	const projMaxAbsTol = 2e-3
	if projMaxAbs > projMaxAbsTol {
		t.Errorf("projector: max|Δ| = %.3e (tol %.0e)", projMaxAbs, projMaxAbsTol)
	}
	t.Logf("projector: max|Δ| = %.3e (tol %.0e), shape %dx%d", projMaxAbs, projMaxAbsTol, len(projected), len(projected[0]))
}
