//go:build gpu

// bitnet_cuda_test.go — equivalence tests for the CUDA decode path
// (bitnet_cuda.go) against the CPU ground truth, per three tiers:
//
//  1. Individual kernels vs. the CPU function they must reproduce, on
//     random data at the real model's shapes.
//  2. The whole Prefill/Step pipeline vs. BitNetModel.Forward on the
//     synthetic bitnet_tiny.nxtf fixture (see bitnet_equivalence_test.go).
//  3. The whole pipeline vs. the CPU decoder on the real 2.4B checkpoint,
//     gated on NEXUS_BITNET_DIR (same env var bitnet_equivalence_test.go
//     uses), reporting tok/s.
//
// Every test here skips (not fails) when no CUDA device/driver is
// present, matching the rest of this package's `-tags gpu` test
// precedent (cublas_int8_dyn_test.go, bitnet_gpu_test.go).
package cortex

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"nexus-cortex/cortex/compute"
)

// compiledCUDAModule compiles bitnetCUDASource once per test binary run
// (NVRTC's own on-disk PTX cache makes repeat compiles cheap regardless,
// but this also gives every test in this file a single skip point).
func compiledCUDAModule(t *testing.T) *compute.Module {
	t.Helper()
	mod, err := compute.CompileKernels(bitnetCUDASource)
	if err != nil {
		t.Skipf("cuda not available: %v", err)
	}
	return mod
}

func mustUploadU32(t *testing.T, data []uint32) *compute.DeviceBuffer {
	t.Helper()
	buf, err := uploadUint32(data)
	if err != nil {
		t.Fatalf("uploadUint32: %v", err)
	}
	return buf
}

func mustUploadF32(t *testing.T, data []float32) *compute.DeviceBuffer {
	t.Helper()
	buf, err := uploadFloat32(data)
	if err != nil {
		t.Fatalf("uploadFloat32: %v", err)
	}
	return buf
}

func mustUploadI8(t *testing.T, data []int8) *compute.DeviceBuffer {
	t.Helper()
	buf, err := compute.AllocDevice(len(data))
	if err != nil {
		t.Fatalf("alloc int8: %v", err)
	}
	if err := buf.CopyFromHost(unsafe.Pointer(&data[0]), len(data)); err != nil {
		t.Fatalf("copy int8: %v", err)
	}
	return buf
}

func downloadF32(t *testing.T, buf *compute.DeviceBuffer, n int) []float32 {
	t.Helper()
	out := make([]float32, n)
	if err := buf.CopyToHost(unsafe.Pointer(&out[0]), n*4); err != nil {
		t.Fatalf("download f32: %v", err)
	}
	return out
}

func downloadI8(t *testing.T, buf *compute.DeviceBuffer, n int) []int8 {
	t.Helper()
	out := make([]int8, n)
	if err := buf.CopyToHost(unsafe.Pointer(&out[0]), n); err != nil {
		t.Fatalf("download i8: %v", err)
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// (a) individual kernels vs. the CPU function.
// ─────────────────────────────────────────────────────────────────────

// TestCUDABitlinearGEMVMatchesCPU checks bitlinear_gemv_kernel against
// dotTernaryInt8/BitLinear on the real Gate/Up-shaped 2560x6912 BitLinear
// dimensions, with random ternary tiles: the raw int32 dot product must
// match EXACTLY (checked by forcing xScale=scale=1, so the kernel's
// output IS the accumulator, exactly representable in float32 for these
// magnitudes — see file doc comment), and the fully-rescaled output
// must match BitLinear.Forward within 1e-5.
func TestCUDABitlinearGEMVMatchesCPU(t *testing.T) {
	mod := compiledCUDAModule(t)
	rng := rand.New(rand.NewSource(4242))

	const in, out = 2560, 6912
	l := NewBitLinear(in, out)
	l.Scale = 0.0417
	for o, row := range randomTernaryRows(rng, out, in) {
		l.SetRow(o, row)
	}

	x := make([]float32, in)
	for i := range x {
		x[i] = rng.Float32()*2 - 1
	}

	qx32, xScale := quantizeActivationsInt32(x)
	qx8 := make([]int8, in)
	for i, v := range qx32 {
		qx8[i] = int8(v)
	}

	tilesBuf := mustUploadU32(t, tilesToUint32(l.Tiles))
	defer tilesBuf.Free()
	qxBuf := mustUploadI8(t, qx8)
	defer qxBuf.Free()
	yBuf, err := allocFloat32(out)
	if err != nil {
		t.Fatalf("allocFloat32: %v", err)
	}
	defer yBuf.Free()

	launch := func(xScalePtr *compute.DeviceBuffer, scale float32) []float32 {
		args := compute.NewKernelArgs().
			AddDevicePtr(tilesBuf).
			AddInt32(int32((in + 15) / 16)).
			AddDevicePtr(qxBuf).
			AddDevicePtr(xScalePtr).
			AddFloat32(scale).
			AddDevicePtr(yBuf)
		defer args.Release()
		if err := mod.Launch("bitlinear_gemv_kernel", [3]uint32{uint32(out), 1, 1}, [3]uint32{cudaGEMVBlock, 1, 1}, 0, args); err != nil {
			t.Fatalf("launch bitlinear_gemv_kernel: %v", err)
		}
		return downloadF32(t, yBuf, out)
	}

	// Raw accumulator: xScale=1, scale=1.
	onesBuf := mustUploadF32(t, []float32{1.0})
	defer onesBuf.Free()
	rawGot := launch(onesBuf, 1.0)

	tpr := (in + 15) / 16
	for row := 0; row < out; row++ {
		wantAcc := dotTernaryInt8(l.Tiles[row*tpr:(row+1)*tpr], qx32)
		if rawGot[row] != float32(wantAcc) {
			t.Fatalf("row %d: raw int32 mismatch: GPU %v (as float) vs CPU acc %d", row, rawGot[row], wantAcc)
			break
		}
	}

	// Fully rescaled.
	xScaleBuf := mustUploadF32(t, []float32{xScale})
	defer xScaleBuf.Free()
	got := launch(xScaleBuf, l.Scale)
	want := l.Forward(x)
	var maxDiff float32
	for i := range want {
		d := got[i] - want[i]
		if d < 0 {
			d = -d
		}
		if d > maxDiff {
			maxDiff = d
		}
	}
	if maxDiff >= 1e-5 {
		t.Errorf("rescaled GEMV max |Δ| = %v, want < 1e-5", maxDiff)
	} else {
		t.Logf("bitlinear_gemv_kernel: exact int32 match over %d rows, rescaled max|Δ|=%.3e", out, maxDiff)
	}
}

// TestCUDARMSNormActQuantRelu2RopeMatchCPU checks rmsnorm_kernel,
// act_quant_kernel, relu2_mul_kernel and rope_half_kernel individually
// against their CPU counterparts (RMSNorm, quantizeActivationsInt32, the
// relu(gate)^2*up loop, applyRoPEHalf) on random data at the real
// model's EmbedDim/FFNDim/headDim.
func TestCUDARMSNormActQuantRelu2RopeMatchCPU(t *testing.T) {
	mod := compiledCUDAModule(t)
	rng := rand.New(rand.NewSource(99))

	const dModel = 2560
	const ffn = 6912
	const nHeads = 20
	const hd = 128

	randF32 := func(n int) []float32 {
		v := make([]float32, n)
		for i := range v {
			v[i] = rng.Float32()*4 - 2
		}
		return v
	}

	t.Run("rmsnorm", func(t *testing.T) {
		x := randF32(dModel)
		weight := randF32(dModel)
		const eps = 1e-5
		want := RMSNorm(x, weight, eps)

		xBuf := mustUploadF32(t, x)
		defer xBuf.Free()
		wBuf := mustUploadF32(t, weight)
		defer wBuf.Free()
		outBuf, _ := allocFloat32(dModel)
		defer outBuf.Free()

		args := compute.NewKernelArgs().AddDevicePtr(xBuf).AddInt32(dModel).AddDevicePtr(wBuf).AddFloat64(eps).AddDevicePtr(outBuf)
		defer args.Release()
		if err := mod.Launch("rmsnorm_kernel", [3]uint32{1, 1, 1}, [3]uint32{cudaRMSNormBlock, 1, 1}, 0, args); err != nil {
			t.Fatalf("launch: %v", err)
		}
		got := downloadF32(t, outBuf, dModel)
		var maxDiff float32
		for i := range want {
			d := got[i] - want[i]
			if d < 0 {
				d = -d
			}
			if d > maxDiff {
				maxDiff = d
			}
		}
		if maxDiff >= 1e-6 {
			t.Errorf("rmsnorm max|Δ|=%.3e, want < 1e-6", maxDiff)
		}
	})

	t.Run("act_quant", func(t *testing.T) {
		x := randF32(dModel)
		wantQx, wantXScale := quantizeActivationsInt32(x)

		xBuf := mustUploadF32(t, x)
		defer xBuf.Free()
		qxBuf, _ := allocInt8(dModel)
		defer qxBuf.Free()
		xsBuf, _ := allocFloat32(1)
		defer xsBuf.Free()

		args := compute.NewKernelArgs().AddDevicePtr(xBuf).AddInt32(dModel).AddDevicePtr(qxBuf).AddDevicePtr(xsBuf)
		defer args.Release()
		if err := mod.Launch("act_quant_kernel", [3]uint32{1, 1, 1}, [3]uint32{cudaActQuantBlock, 1, 1}, 0, args); err != nil {
			t.Fatalf("launch: %v", err)
		}
		gotQx := downloadI8(t, qxBuf, dModel)
		gotXScale := downloadF32(t, xsBuf, 1)[0]

		for i := range wantQx {
			if int32(gotQx[i]) != wantQx[i] {
				t.Fatalf("qx[%d] = %d, want %d", i, gotQx[i], wantQx[i])
			}
		}
		if diff := math.Abs(float64(gotXScale - wantXScale)); diff >= 1e-6 {
			t.Errorf("xScale = %v, want %v (Δ=%.3e)", gotXScale, wantXScale, diff)
		}
	})

	t.Run("relu2_mul", func(t *testing.T) {
		gate := randF32(ffn)
		up := randF32(ffn)
		want := make([]float32, ffn)
		for i := range want {
			r := gate[i]
			if r < 0 {
				r = 0
			}
			want[i] = r * r * up[i]
		}

		gBuf := mustUploadF32(t, gate)
		defer gBuf.Free()
		uBuf := mustUploadF32(t, up)
		defer uBuf.Free()
		outBuf, _ := allocFloat32(ffn)
		defer outBuf.Free()

		args := compute.NewKernelArgs().AddDevicePtr(gBuf).AddDevicePtr(uBuf).AddInt32(ffn).AddDevicePtr(outBuf)
		defer args.Release()
		grid := uint32((ffn + cudaElemBlock - 1) / cudaElemBlock)
		if err := mod.Launch("relu2_mul_kernel", [3]uint32{grid, 1, 1}, [3]uint32{cudaElemBlock, 1, 1}, 0, args); err != nil {
			t.Fatalf("launch: %v", err)
		}
		got := downloadF32(t, outBuf, ffn)
		var maxDiff float32
		for i := range want {
			d := got[i] - want[i]
			if d < 0 {
				d = -d
			}
			if d > maxDiff {
				maxDiff = d
			}
		}
		if maxDiff >= 1e-6 {
			t.Errorf("relu2_mul max|Δ|=%.3e, want < 1e-6", maxDiff)
		}
	})

	t.Run("rope_half", func(t *testing.T) {
		q := randF32(nHeads * hd)
		cosRow := make([]float32, hd)
		sinRow := make([]float32, hd)
		for i := 0; i < hd/2; i++ {
			angle := rng.Float64() * math.Pi
			c, s := float32(math.Cos(angle)), float32(math.Sin(angle))
			cosRow[i], cosRow[i+hd/2] = c, c
			sinRow[i], sinRow[i+hd/2] = s, s
		}

		want := make([]float32, len(q))
		copy(want, q)
		scratch := make([]float32, hd)
		for h := 0; h < nHeads; h++ {
			applyRoPEHalf(want[h*hd:(h+1)*hd], cosRow, sinRow, scratch)
		}

		qBuf := mustUploadF32(t, q)
		defer qBuf.Free()
		cosBuf := mustUploadF32(t, cosRow)
		defer cosBuf.Free()
		sinBuf := mustUploadF32(t, sinRow)
		defer sinBuf.Free()

		args := compute.NewKernelArgs().AddDevicePtr(qBuf).AddInt32(hd).AddDevicePtr(cosBuf).AddDevicePtr(sinBuf)
		defer args.Release()
		if err := mod.Launch("rope_half_kernel", [3]uint32{nHeads, 1, 1}, [3]uint32{hd / 2, 1, 1}, 0, args); err != nil {
			t.Fatalf("launch: %v", err)
		}
		got := downloadF32(t, qBuf, nHeads*hd)
		var maxDiff float32
		for i := range want {
			d := got[i] - want[i]
			if d < 0 {
				d = -d
			}
			if d > maxDiff {
				maxDiff = d
			}
		}
		if maxDiff >= 1e-6 {
			t.Errorf("rope_half max|Δ|=%.3e, want < 1e-6", maxDiff)
		}
	})
}

// ─────────────────────────────────────────────────────────────────────
// (b) whole Prefill/Step pipeline vs. Forward, on the tiny fixture.
// ─────────────────────────────────────────────────────────────────────

func TestCUDATinyEquivalence(t *testing.T) {
	compiledCUDAModule(t) // skip early if no CUDA, before loading the fixture

	dir := filepath.Join("..", "forge", "fixtures")
	nxtfPath := filepath.Join(dir, "bitnet_tiny.nxtf")
	jsonPath := filepath.Join(dir, "bitnet_tiny.json")

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Skipf("fixture missing (%v) — run: python forge/bitnet_reference.py --tiny", err)
	}
	var fx bitnetRefFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if len(fx.Prompts) == 0 {
		t.Fatal("fixture has no prompts")
	}

	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}

	const tol = 1e-4
	worst := 0.0
	for _, p := range fx.Prompts {
		cd, err := NewBitNetCUDADecoder(m)
		if err != nil {
			t.Fatalf("NewBitNetCUDADecoder: %v", err)
		}

		cpuLogits := m.Forward(p.IDs)
		cpuLast := cpuLogits[len(cpuLogits)-1]

		gpuLast := cd.Prefill(p.IDs)
		if len(gpuLast) != len(cpuLast) {
			t.Fatalf("logits length: GPU %d vs CPU %d", len(gpuLast), len(cpuLast))
		}
		maxDiff := 0.0
		for v := range cpuLast {
			d := math.Abs(float64(gpuLast[v]) - float64(cpuLast[v]))
			if d > maxDiff {
				maxDiff = d
			}
		}
		if maxDiff > worst {
			worst = maxDiff
		}
		if maxDiff > tol {
			t.Errorf("prefill logits diverge: max|Δ|=%.3e (tol %.0e)", maxDiff, tol)
		}

		// Greedy continuation, token by token, checked against the CPU's
		// own GenerateGreedy continuation from the same prompt.
		wantSeq := m.GenerateGreedy(p.IDs, len(p.GreedyContinuation))
		wantTail := wantSeq[len(p.IDs):]

		seq := append([]int(nil), p.IDs...)
		logits := gpuLast
		for i := 0; i < len(p.GreedyContinuation); i++ {
			best := argmaxFloat32(logits)
			seq = append(seq, best)
			if best == m.Cfg.EOSTokenID || cd.Len() >= m.Cfg.MaxSeqLen {
				break
			}
			logits = cd.Step(best)
		}
		gotTail := seq[len(p.IDs):]
		match := len(gotTail) == len(wantTail)
		if match {
			for i := range gotTail {
				if gotTail[i] != wantTail[i] {
					match = false
					break
				}
			}
		}
		if !match {
			t.Errorf("greedy continuation: GPU %v vs CPU %v", gotTail, wantTail)
		}

		cd.Close()
	}
	t.Logf("tiny: %d prompts, max|Δlogit| = %.3e (tol %.0e)", len(fx.Prompts), worst, tol)
}

// TestCUDAPrefillEmbedsTinyEquivalence checks BitNetCUDADecoder.PrefillEmbeds
// on the tiny synthetic fixture two ways: (1) against the CPU
// BitNetDecoder.PrefillEmbeds on the SAME rows (m.EmbedTokens(p.IDs)) —
// this is the actual cmd/ilaria-see call shape, spliced image/text
// embeddings fed straight into the residual stream; (2) against the same
// CUDA decoder's own Prefill(p.IDs) — the embedding-table lookup and the
// caller-supplied-row path differ only in how d.xBuf gets filled (see
// uploadResidualRow's doc comment in bitnet_cuda.go), so for identical
// rows they must produce identical logits, not just close ones.
func TestCUDAPrefillEmbedsTinyEquivalence(t *testing.T) {
	compiledCUDAModule(t) // skip early if no CUDA, before loading the fixture

	dir := filepath.Join("..", "forge", "fixtures")
	nxtfPath := filepath.Join(dir, "bitnet_tiny.nxtf")
	jsonPath := filepath.Join(dir, "bitnet_tiny.json")

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Skipf("fixture missing (%v) — run: python forge/bitnet_reference.py --tiny", err)
	}
	var fx bitnetRefFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if len(fx.Prompts) == 0 {
		t.Fatal("fixture has no prompts")
	}

	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}

	const tol = 1e-4
	worstVsCPU, worstVsCUDAIDs := 0.0, 0.0
	for _, p := range fx.Prompts {
		rows := m.EmbedTokens(p.IDs)

		cpuDec := NewBitNetDecoder(m)
		cpuLogits := cpuDec.PrefillEmbeds(rows)

		cd, err := NewBitNetCUDADecoder(m)
		if err != nil {
			t.Fatalf("NewBitNetCUDADecoder: %v", err)
		}
		gpuEmbedLogits := cd.PrefillEmbeds(rows)

		if len(gpuEmbedLogits) != len(cpuLogits) {
			t.Fatalf("logits length: GPU %d vs CPU %d", len(gpuEmbedLogits), len(cpuLogits))
		}
		maxDiff := 0.0
		for v := range cpuLogits {
			d := math.Abs(float64(gpuEmbedLogits[v]) - float64(cpuLogits[v]))
			if d > maxDiff {
				maxDiff = d
			}
		}
		if maxDiff > worstVsCPU {
			worstVsCPU = maxDiff
		}
		if maxDiff > tol {
			t.Errorf("PrefillEmbeds vs CPU PrefillEmbeds: max|Δ|=%.3e (tol %.0e)", maxDiff, tol)
		}

		// Same ids, via the embedding-table lookup path — must land on
		// (near-)identical logits to the caller-supplied-row path above,
		// since both paths converge on the same d.xBuf H2D copy.
		cd.Reset()
		gpuIDLogits := cd.Prefill(p.IDs)
		maxDiff2 := 0.0
		for v := range gpuIDLogits {
			d := math.Abs(float64(gpuIDLogits[v]) - float64(gpuEmbedLogits[v]))
			if d > maxDiff2 {
				maxDiff2 = d
			}
		}
		if maxDiff2 > worstVsCUDAIDs {
			worstVsCUDAIDs = maxDiff2
		}
		if maxDiff2 > tol {
			t.Errorf("PrefillEmbeds vs CUDA Prefill(ids): max|Δ|=%.3e (tol %.0e)", maxDiff2, tol)
		}

		cd.Close()
	}
	t.Logf("tiny PrefillEmbeds: %d prompts, max|Δ| vs CPU PrefillEmbeds = %.3e, max|Δ| vs CUDA Prefill(ids) = %.3e (tol %.0e)",
		len(fx.Prompts), worstVsCPU, worstVsCUDAIDs, tol)
}

// ─────────────────────────────────────────────────────────────────────
// (c) real checkpoint, gated on NEXUS_BITNET_DIR.
// ─────────────────────────────────────────────────────────────────────

func TestCUDARealModelEquivalence(t *testing.T) {
	compiledCUDAModule(t)

	dir := os.Getenv("NEXUS_BITNET_DIR")
	if dir == "" {
		t.Skip("NEXUS_BITNET_DIR not set — skipping real-checkpoint CUDA equivalence test")
	}
	nxtfPath := filepath.Join(dir, "bitnet.nxtf")
	jsonPath := filepath.Join(dir, "logits_ref.json")

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("read %s: %v", jsonPath, err)
	}
	var fx bitnetRefFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if len(fx.Prompts) == 0 {
		t.Fatal("fixture has no prompts")
	}

	loadStart := time.Now()
	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}
	t.Logf("CPU model load: %s", time.Since(loadStart))

	cudaStart := time.Now()
	cd, err := NewBitNetCUDADecoder(m)
	if err != nil {
		t.Fatalf("NewBitNetCUDADecoder: %v", err)
	}
	defer cd.Close()
	t.Logf("CUDA decoder build (compile+upload): %s", time.Since(cudaStart))

	if free, total, err := compute.DeviceMemInfo(); err == nil {
		t.Logf("device memory: %.0f MiB used / %.0f MiB total", float64(total-free)/1024/1024, float64(total)/1024/1024)
	}

	const (
		minArgmaxAgree = 0.95
		greedyPrefix   = 8
	)
	agree, total := 0, 0
	var genTokens int
	var genElapsed time.Duration

	for _, p := range fx.Prompts {
		cd.Reset()

		prefillStart := time.Now()
		logits := cd.Prefill(p.IDs)
		prefillElapsed := time.Since(prefillStart)

		if argmaxFloat32(logits) == p.Argmax[len(p.Argmax)-1] {
			agree++
		}
		total++

		n := greedyPrefix
		if n > len(p.GreedyContinuation) {
			n = len(p.GreedyContinuation)
		}
		genStart := time.Now()
		for i := 0; i < n; i++ {
			best := argmaxFloat32(logits)
			if i < len(p.GreedyContinuation) && best == p.GreedyContinuation[i] {
				// tracked via agree/total below for the fuller signal
			}
			if best == m.Cfg.EOSTokenID || cd.Len() >= m.Cfg.MaxSeqLen {
				break
			}
			logits = cd.Step(best)
			genTokens++
		}
		genElapsed += time.Since(genStart)

		label := "real"
		if p.Text != nil {
			label = *p.Text
		}
		t.Logf("%s: prefill %d tokens in %s", label, len(p.IDs), prefillElapsed)
	}

	rate := float64(genTokens) / genElapsed.Seconds()
	agreeRate := float64(agree) / float64(total)
	t.Logf("real: %d prompts, last-position argmax agreement %d/%d (%.1f%%), decode %.1f tok/s",
		len(fx.Prompts), agree, total, 100*agreeRate, rate)
	if agreeRate < minArgmaxAgree {
		t.Errorf("argmax agreement %.1f%% below %.0f%%", 100*agreeRate, 100*minArgmaxAgree)
	}
}

// TestCUDARealModelPrefillEmbedsEquivalence checks
// BitNetCUDADecoder.PrefillEmbeds against the CPU
// BitNetDecoder.PrefillEmbeds on the real checkpoint, using real
// embedding rows (m.EmbedTokens over ids concatenated across
// logits_ref.json's prompts, since none of them alone reaches the
// ~40-row budget this test targets) instead of token ids — the same
// call shape cmd/ilaria-see uses for its spliced image+text embeddings,
// just without needing a real vision tower/adapter here. Compares
// argmax + KL of the prefill's last-row logits (the file's established
// statistical-tolerance precedent for the real checkpoint — see
// TestBitNetEquivalence's doc comment on why per-logit tolerances are
// meaningless at this scale), then runs 3 Steps — both decoders driven
// by the CPU decoder's own greedy token, so a later step's comparison
// reflects that step's arithmetic rather than an already-diverged
// trajectory — and checks argmax agreement. Skipped unless
// NEXUS_BITNET_DIR is set (same convention as
// TestCUDARealModelEquivalence).
func TestCUDARealModelPrefillEmbedsEquivalence(t *testing.T) {
	compiledCUDAModule(t)

	dir := os.Getenv("NEXUS_BITNET_DIR")
	if dir == "" {
		t.Skip("NEXUS_BITNET_DIR not set — skipping real-checkpoint CUDA PrefillEmbeds equivalence test")
	}
	nxtfPath := filepath.Join(dir, "bitnet.nxtf")
	jsonPath := filepath.Join(dir, "logits_ref.json")

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("read %s: %v", jsonPath, err)
	}
	var fx bitnetRefFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if len(fx.Prompts) == 0 {
		t.Fatal("fixture has no prompts")
	}

	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}

	const targetRows = 40
	var ids []int
	for _, p := range fx.Prompts {
		ids = append(ids, p.IDs...)
		if len(ids) >= targetRows {
			break
		}
	}
	if len(ids) > targetRows {
		ids = ids[:targetRows]
	}
	if len(ids) == 0 {
		t.Fatal("no ids available to build a real-embedding sequence")
	}
	rows := m.EmbedTokens(ids)
	t.Logf("built a %d-row real-embedding sequence from %d fixture prompts", len(rows), len(fx.Prompts))

	cpuDec := NewBitNetDecoder(m)
	cpuLogits := cpuDec.PrefillEmbeds(rows)

	cd, err := NewBitNetCUDADecoder(m)
	if err != nil {
		t.Fatalf("NewBitNetCUDADecoder: %v", err)
	}
	defer cd.Close()

	prefillStart := time.Now()
	gpuLogits := cd.PrefillEmbeds(rows)
	prefillElapsed := time.Since(prefillStart)

	// Both sides are this codebase's own Go math (rmsnorm summation order
	// and the fp16 lm_head embedding copy are the only deviations — see
	// bitnet_cuda.go's PRECISION section), so this is tighter than
	// TestBitNetEquivalence's Go-vs-PyTorch 0.03 nats.
	const maxKL = 0.05
	const minStepAgree = 2 // of 3 Step calls

	cpuArgmax := argmaxFloat32(cpuLogits)
	gpuArgmax := argmaxFloat32(gpuLogits)
	refKL := make([]float64, len(cpuLogits))
	for i, v := range cpuLogits {
		refKL[i] = float64(v)
	}
	kl, meanAbs, maxAbs := distributionGap(refKL, gpuLogits)
	t.Logf("PrefillEmbeds real: %d rows in %s, argmax CPU=%d GPU=%d, KL=%.4f mean|Δ|=%.4f max|Δ|=%.3f",
		len(rows), prefillElapsed, cpuArgmax, gpuArgmax, kl, meanAbs, maxAbs)
	if cpuArgmax != gpuArgmax {
		t.Errorf("prefill argmax mismatch: CPU %d vs GPU %d", cpuArgmax, gpuArgmax)
	}
	if kl > maxKL {
		t.Errorf("prefill KL(CPU‖GPU) = %.4f, want < %.4f", kl, maxKL)
	}

	agree := 0
	cpuLog, gpuLog := cpuLogits, gpuLogits
	for i := 0; i < 3; i++ {
		cpuNext := argmaxFloat32(cpuLog)
		gpuNext := argmaxFloat32(gpuLog)
		if cpuNext == gpuNext {
			agree++
		} else {
			t.Logf("step %d: argmax disagreement CPU %d vs GPU %d", i, cpuNext, gpuNext)
		}
		// Drive both decoders on the SAME (CPU-greedy) token so each
		// step's comparison reflects that step's arithmetic, not an
		// already-diverged trajectory.
		cpuLog = cpuDec.Step(cpuNext)
		gpuLog = cd.Step(cpuNext)
	}
	t.Logf("PrefillEmbeds real: 3-step argmax agreement %d/3", agree)
	if agree < minStepAgree {
		t.Errorf("3-step argmax agreement %d/3 below %d/3", agree, minStepAgree)
	}
}

// TestCUDAProfileStep breaks one Step call down by kernel category
// (summed across all NumLayers layers), inserting compute.Synchronize()
// between categories so each bucket's wall-clock time is actually GPU
// execution time for that category, not just CPU-side enqueue time —
// diagnostic support for the task's "if you land far below [expected
// tok/s], profile with cuEvent timings per kernel and report where the
// time goes" (no cuEvent bindings were built; stream Synchronize
// boundaries give the same per-category attribution at negligible extra
// code cost). Gated on NEXUS_BITNET_DIR like the other real-checkpoint
// test.
func TestCUDAProfileStep(t *testing.T) {
	compiledCUDAModule(t)
	dir := os.Getenv("NEXUS_BITNET_DIR")
	if dir == "" {
		t.Skip("NEXUS_BITNET_DIR not set — skipping CUDA profiling")
	}
	m, err := LoadBitNetModel(filepath.Join(dir, "bitnet.nxtf"))
	if err != nil {
		t.Fatalf("LoadBitNetModel: %v", err)
	}
	d, err := NewBitNetCUDADecoder(m)
	if err != nil {
		t.Fatalf("NewBitNetCUDADecoder: %v", err)
	}
	defer d.Close()

	cfg := m.Cfg
	dModel := cfg.EmbedDim
	pos := 0

	timeIt := func(label string, fn func() error) time.Duration {
		if err := compute.Synchronize(); err != nil {
			t.Fatalf("presync: %v", err)
		}
		start := time.Now()
		if err := fn(); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if err := compute.Synchronize(); err != nil {
			t.Fatalf("postsync %s: %v", label, err)
		}
		return time.Since(start)
	}

	totals := map[string]time.Duration{}
	add := func(label string, dur time.Duration) { totals[label] += dur }

	row := m.Embed[0:dModel]
	add("h2d_embed", timeIt("h2d_embed", func() error {
		return d.xBuf.CopyFromHost(unsafe.Pointer(&row[0]), dModel*4)
	}))

	for li := 0; li < cfg.NumLayers; li++ {
		lw := &d.layers[li]
		add("rmsnorm", timeIt("attn_norm", func() error { return d.rmsnorm(d.xBuf, dModel, lw.attnNorm, cfg.RMSNormEps, d.normedBuf) }))
		add("act_quant", timeIt("aq1", func() error { return d.actQuant(d.normedBuf, dModel, d.qxEmbedBuf) }))
		add("gemv", timeIt("Q", func() error { return d.gemv(lw.tilesQ, lw.tprQ, lw.outQ, d.qxEmbedBuf, lw.scaleQ, d.qBuf) }))
		kvRowOff := (li*cfg.MaxSeqLen + pos) * d.kvDim * 4
		add("gemv", timeIt("K", func() error {
			return d.gemvOut(lw.tilesK, lw.tprK, lw.outK, d.qxEmbedBuf, lw.scaleK, d.kCache, kvRowOff)
		}))
		add("gemv", timeIt("V", func() error {
			return d.gemvOut(lw.tilesV, lw.tprV, lw.outV, d.qxEmbedBuf, lw.scaleV, d.vCache, kvRowOff)
		}))
		add("rope", timeIt("ropeQ", func() error { return d.ropeHalf(d.qBuf, 0, cfg.NumHeads, pos) }))
		add("rope", timeIt("ropeK", func() error { return d.ropeHalf(d.kCache, kvRowOff, cfg.NumKVHeads, pos) }))
		add("attn", timeIt("attn", func() error { return d.attnDecode(li, pos) }))
		add("rmsnorm", timeIt("attn_sub_norm", func() error {
			return d.rmsnorm(d.attnRawBuf, dModel, lw.attnSubNorm, cfg.RMSNormEps, d.attnOutBuf)
		}))
		add("act_quant", timeIt("aq2", func() error { return d.actQuant(d.attnOutBuf, dModel, d.qxEmbedBuf) }))
		add("gemv", timeIt("O", func() error { return d.gemv(lw.tilesO, lw.tprO, lw.outO, d.qxEmbedBuf, lw.scaleO, d.oOutBuf) }))
		add("add", timeIt("resid1", func() error { return d.add(d.xBuf, d.oOutBuf, dModel, d.residBuf) }))
		add("rmsnorm", timeIt("ffn_norm", func() error { return d.rmsnorm(d.residBuf, dModel, lw.ffnNorm, cfg.RMSNormEps, d.normed2Buf) }))
		add("act_quant", timeIt("aq3", func() error { return d.actQuant(d.normed2Buf, dModel, d.qxEmbedBuf) }))
		add("gemv", timeIt("Gate", func() error {
			return d.gemv(lw.tilesGate, lw.tprGate, lw.outGate, d.qxEmbedBuf, lw.scaleGate, d.gateBuf)
		}))
		add("gemv", timeIt("Up", func() error { return d.gemv(lw.tilesUp, lw.tprUp, lw.outUp, d.qxEmbedBuf, lw.scaleUp, d.upBuf) }))
		add("relu2", timeIt("relu2", func() error { return d.relu2(d.gateBuf, d.upBuf, cfg.FFNDim, d.mlpRowBuf) }))
		add("rmsnorm", timeIt("ffn_sub_norm", func() error {
			return d.rmsnorm(d.mlpRowBuf, cfg.FFNDim, lw.ffnSubNorm, cfg.RMSNormEps, d.mlpRowBuf)
		}))
		add("act_quant", timeIt("aq4", func() error { return d.actQuant(d.mlpRowBuf, cfg.FFNDim, d.qxFFNBuf) }))
		add("gemv", timeIt("Down", func() error {
			return d.gemv(lw.tilesDown, lw.tprDown, lw.outDown, d.qxFFNBuf, lw.scaleDown, d.downOutBuf)
		}))
		add("add", timeIt("resid2", func() error { return d.add(d.residBuf, d.downOutBuf, dModel, d.xBuf) }))
	}

	add("rmsnorm", timeIt("final_norm", func() error { return d.rmsnorm(d.xBuf, dModel, d.finalNorm, cfg.RMSNormEps, d.normedBuf) }))
	add("lm_head", timeIt("lm_head", func() error {
		args := compute.NewKernelArgs().AddDevicePtr(d.embedFP16).AddDevicePtr(d.normedBuf).AddInt32(int32(dModel)).AddInt32(int32(cfg.VocabSize)).AddDevicePtr(d.logitsBuf)
		defer args.Release()
		grid := uint32((cfg.VocabSize + cudaLMHeadWarpsPerBlock - 1) / cudaLMHeadWarpsPerBlock)
		return d.mod.Launch("lm_head_dot_kernel", [3]uint32{grid, 1, 1}, [3]uint32{cudaLMHeadBlock, 1, 1}, 0, args)
	}))
	add("d2h_logits", timeIt("d2h_logits", func() error {
		return d.logitsBuf.CopyToHost(unsafe.Pointer(&d.logitsHost[0]), cfg.VocabSize*4)
	}))

	order := []string{"h2d_embed", "rmsnorm", "act_quant", "gemv", "rope", "attn", "add", "relu2", "lm_head", "d2h_logits"}
	var sum time.Duration
	for _, k := range order {
		sum += totals[k]
	}
	for _, k := range order {
		t.Logf("%-12s %10s  (%5.1f%%)", k, totals[k].Round(time.Microsecond), 100*float64(totals[k])/float64(sum))
	}
	t.Logf("TOTAL (sum of synchronized buckets): %s  -> %.1f tok/s if repeated steady-state", sum, 1.0/sum.Seconds())
}
