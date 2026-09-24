//go:build gpu

// bitnet_gpu.go — resident cuBLAS int8 GEMM backend for BitLinear, built
// on cortex/compute's cublas_int8_dyn.go (build tag `gpu && windows`).
//
// See bitnet_backend.go for the dispatch seam and bitnet_linear.go's
// BitLinear.gpu field / the one-line "GPU HOOK" at the top of
// ForwardBatch — this file only ever SETS that field (in
// EnableBitNetGPU) and implements what it points at.
//
// Every BitLinear's weight is uploaded ONCE as int8 {-1,0,1}
// (unpackBitLinearInt8, undoing PackTernaryTile) — 7 matrices per layer
// (Q,K,V,O,Gate,Up,Down) x NumLayers layers. The tied token
// embedding/lm_head is NOT a BitLinear (bitnet.go never wraps it in
// one — see Forward's doc comment) and is deliberately left alone here:
// it stays on the CPU path unconditionally, matching the task's
// "keep lm_head on the CPU path" decision (it's bf16-precision, not
// ternary, so it wouldn't fit this int8 backend's contract anyway).
package cortex

import (
	"fmt"

	"nexus-cortex/cortex/compute"
)

// bitLinearGPUImpl implements bitLinearGPU with a resident cuBLAS int8
// GEMM: per call it quantizes activations exactly as the CPU path
// (quantizeActivationsInt32, same function — bitnet_gpu.go is in package
// cortex, so it calls the unexported helper directly rather than
// reimplementing it; the int32-widened values it returns are already
// clamped to [-128,127], so narrowing to int8 for upload is exact), runs
// int8x8->int32 GEMM against the resident weight (bit-identical to the
// CPU's own int32 accumulation — integer addition has no rounding or
// association-order sensitivity, proven against a plain Go reference by
// cortex/compute's TestMatMulInt8NTTinyAgainstReference), and rescales
// with `float32(acc) * (xScale * Scale)`.
//
// That rescale's multiplication order is NOT always what
// bitLinearForwardRows (bitnet_linear.go) computes for a given row: it
// takes this exact order on its 4-rows-at-a-time path, but falls to
// `float32(acc) * xScale * Scale` (left-to-right) on the single-row
// remainder of whatever chunk bitnetParallelFor split Out into — and
// that chunk width is ceil(Out/GOMAXPROCS(0)), a RUNTIME-dependent
// value, so which rows take which order is machine-dependent even for
// the same BitLinear. For the real BitNet-2B4T shapes (EmbedDim=2560,
// FFNDim=6912, kvDim=640) this resolves in this backend's favor on
// every core count tried so far (each divides evenly enough that every
// chunk is itself a multiple of 4), but that isn't a hard guarantee.
// Per the task contract's documented fallback, the (rare, sub-ULP)
// deviation this can produce is verified statistically rather than
// required to vanish: TestBitLinearGPUMatchesCPU (bitnet_gpu_test.go)
// bounds a relative-L2 norm instead of demanding bit-for-bit equality,
// and TestBitNetEquivalence's much looser bounds
// (bitnet_equivalence_test.go) cover the same question at full model
// scale.
type bitLinearGPUImpl struct {
	handle  int
	out, in int
	scale   float32
}

// forward implements bitLinearGPU.
func (b *bitLinearGPUImpl) forward(x [][]float32) [][]float32 {
	T := len(x)
	out := make([][]float32, T)
	if T == 0 {
		return out
	}

	act := make([]int8, T*b.in)
	xScales := make([]float32, T)
	for t, row := range x {
		qx, xs := quantizeActivationsInt32(row)
		dst := act[t*b.in : (t+1)*b.in]
		for i, v := range qx {
			dst[i] = int8(v) // exact: quantizeActivationsInt32 already clamps to [-128,127]
		}
		xScales[t] = xs
	}

	res, err := compute.MatMulInt8NT(b.handle, act, T, b.out, b.in)
	if err != nil {
		// ForwardBatch (bitnet_linear.go) has no error return, and a
		// silent CPU fallback here would have to duplicate
		// dotTernaryInt8's bit-loop — logic owned by bitnet_linear.go,
		// which another agent is concurrently optimizing — so instead
		// of risking silent divergence from whatever that loop now
		// does, a GPU failure mid-run fails loud.
		panic(fmt.Sprintf("cortex: bitLinearGPUImpl.forward: %v", err))
	}

	for t := range out {
		row := make([]float32, b.out)
		base := t * b.out
		f := xScales[t] * b.scale
		for j := 0; j < b.out; j++ {
			row[j] = float32(res[base+j]) * f
		}
		out[t] = row
	}
	return out
}

// unpackBitLinearInt8 flattens l.Tiles into a row-major Out x In int8
// matrix with values in {-1,0,1}, undoing PackTernaryTile/
// TernaryTile.Unpack (ternary.go) — the same packing SetRow's caller
// originally applied, read back out for GPU upload.
func unpackBitLinearInt8(l *BitLinear) []int8 {
	tpr := l.tilesPerRow()
	data := make([]int8, l.Out*l.In)
	for j := 0; j < l.Out; j++ {
		row := l.Tiles[j*tpr : j*tpr+tpr]
		dst := data[j*l.In : (j+1)*l.In]
		for t, tile := range row {
			vals := tile.Unpack()
			base := t * 16
			n := 16
			if base+n > l.In {
				n = l.In - base
			}
			for k := 0; k < n; k++ {
				dst[base+k] = vals[k]
			}
		}
	}
	return data
}

// bitLinearsOf returns one BitNetLayer's seven BitLinear matrices in a
// fixed order, shared by EnableBitNetGPU and DisableBitNetGPU.
func bitLinearsOf(layer *BitNetLayer) [7]*BitLinear {
	return [7]*BitLinear{layer.Q, layer.K, layer.V, layer.O, layer.Gate, layer.Up, layer.Down}
}

// EnableBitNetGPU uploads every BitLinear weight matrix in m (7 per
// layer x NumLayers — 210 for the real 2B4T checkpoint) to the GPU as
// int8 and attaches a bitLinearGPUImpl to each, so every subsequent
// BitLinear.ForwardBatch call is served by the resident cuBLAS int8
// GEMM backend. Both BitNetModel.Forward and BitNetDecoder.Prefill/Step
// call ForwardBatch exclusively (never the single-row Forward), so this
// covers the whole model. On any upload failure, already-uploaded
// weights for m are freed and every gpu field is left nil (fully CPU).
func EnableBitNetGPU(m *BitNetModel) error {
	if err := compute.InitCuBLASInt8(); err != nil {
		return fmt.Errorf("gpu init: %w", err)
	}

	var touched []*BitLinear
	teardown := func() {
		for _, l := range touched {
			if impl, ok := l.gpu.(*bitLinearGPUImpl); ok {
				compute.FreeInt8Weight(impl.handle)
			}
			l.gpu = nil
		}
	}

	upload := func(l *BitLinear) error {
		data := unpackBitLinearInt8(l)
		h, err := compute.UploadInt8Weight(data, l.Out, l.In)
		if err != nil {
			return err
		}
		l.gpu = &bitLinearGPUImpl{handle: h, out: l.Out, in: l.In, scale: l.Scale}
		touched = append(touched, l)
		return nil
	}

	for li, layer := range m.Layers {
		for _, l := range bitLinearsOf(layer) {
			if err := upload(l); err != nil {
				teardown()
				return fmt.Errorf("layer %d gpu upload: %w", li, err)
			}
		}
	}
	return nil
}

// DisableBitNetGPU frees every GPU-resident weight EnableBitNetGPU
// uploaded for m and detaches the gpu backend from every BitLinear,
// reverting all subsequent ForwardBatch calls to the CPU path.
func DisableBitNetGPU(m *BitNetModel) {
	for _, layer := range m.Layers {
		for _, l := range bitLinearsOf(layer) {
			if impl, ok := l.gpu.(*bitLinearGPUImpl); ok {
				compute.FreeInt8Weight(impl.handle)
			}
			l.gpu = nil
		}
	}
}
