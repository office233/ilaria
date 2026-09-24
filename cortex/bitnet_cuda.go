//go:build gpu

// bitnet_cuda.go — CUDA decode path for BitNetModel: the whole per-token
// decoder step (RMSNorm → int8 activation quant → ternary GEMV → RoPE →
// GQA attention → ReLU² GLU → residual adds → final RMSNorm → fp16
// lm_head) runs on the GPU with the residual stream, KV cache, and every
// BitLinear weight resident on the device — no host↔device round trip
// per linear, unlike the existing `-gpu` path (bitnet_gpu.go), whose
// cuBLAS int8 GEMM backend still copies activations/results across PCIe
// on every single BitLinear.ForwardBatch call (210 round trips/token).
//
// Kernels are CUDA C compiled AT RUNTIME by NVRTC (cortex/compute's
// nvrtc_dyn.go + cuda_driver_dyn.go, both build-tag `gpu && windows`) —
// no nvcc/MSVC needed, same reasoning as the cuBLAS dynamic-loading
// bridges. This file itself carries only the plain `gpu` tag (not
// `gpu && windows`) so it type-checks on any OS under `-tags gpu`; the
// compute package's nvrtc_stub.go supplies error-returning stand-ins for
// non-Windows/non-gpu builds, and every CUDA call here surfaces through
// ordinary Go error returns from NewBitNetCUDADecoder — construction
// simply fails there on a platform without the real bridge.
//
// GROUND TRUTH: every kernel here reproduces one specific CPU function
// bit-for-bit (int8/int32 paths) or within float64-reduction-order
// tolerance (rmsnorm's double-precision sum, tolerated because tree vs.
// sequential summation order differs by less than 1e-6 for these
// dimensions — see bitnet_cuda_test.go):
//
//	bitlinear_gemv_kernel  <-> dotTernaryInt8 + BitLinear rescale (bitnet_linear.go)
//	rmsnorm_kernel         <-> RMSNorm / rmsNormInto (rmsnorm.go, bitnet_decode.go)
//	act_quant_kernel       <-> quantizeActivationsInt32 (bitnet_linear.go)
//	relu2_mul_kernel       <-> the relu(gate)^2*up loop in bitnetMLP/decodeStepMLP (bitnet.go, bitnet_decode.go)
//	rope_half_kernel       <-> applyRoPEHalf (bitnet.go)
//	attn_decode_kernel     <-> decodeStepAttention's score/softmax/weighted-sum loops (bitnet_decode.go)
//	lm_head_dot_kernel     <-> lmHeadRows (bitnet.go), but embedding rows are fp16
//	                           (documented ~1e-3-scale deviation — see below)
//	add_kernel             <-> the residual `x[i]+attnOut[i]` / `resid[i]+ffnOut[i]` loops
//	argmax_partial_kernel  <-> argmaxFloat32 (bitnet.go) — earliest-index tie-break preserved
//
// PRECISION: the residual stream itself (embeddings in, every
// RMSNorm/GEMV/attention/ReLU² output in between) is float32 end to end,
// identical precision to the CPU path — the token's OWN input embedding
// row is looked up from the model's float32 Embed table and H2D-copied
// fresh every step (a few KB, negligible next to the weight traffic this
// design exists to avoid), never through the fp16 copy. Only lm_head's
// embed·h dot product reads the embedding table through a SEPARATE,
// fp16-truncated device copy (uploadEmbedFP16) — trading ~0.6 GB of
// device memory (1.22 GB fp32 -> 0.61 GB fp16 for the real 2.4B
// checkpoint's 128256x2560 tied embedding) for a small, single-step
// logits deviation that does NOT compound through the 30 decoder layers
// (it only ever affects the final dot product), unlike an fp16 residual
// stream would. bitnet_cuda_test.go's tiny-fixture check (tolerance
// 1e-4) and the real-checkpoint gated test (statistical, tolerance
// ~1e-2..1e-1 scale per bitnet_equivalence_test.go's own precedent)
// both confirm this stays within budget.
//
// KV CACHE: resident on the device as two flat float32 buffers, one for
// K and one for V, each logically [NumLayers][MaxSeqLen][kvDim] — a
// layer's row at position p starts at byte offset
// (layer*MaxSeqLen+p)*kvDim*4. bitlinear_gemv_kernel for K/V writes
// DIRECTLY into that row (via KernelArgs.AddDevicePtrOffset) instead of
// into a scratch buffer that then gets device-to-device-copied in —
// removing an otherwise-per-token-per-layer copy for free. rope_half_kernel
// for K likewise rotates that same cache row in place.
package cortex

import (
	"errors"
	"fmt"
	"math"
	"unsafe"

	"nexus-cortex/cortex/compute"
)

// ─────────────────────────────────────────────────────────────────────
// CUDA C kernel source (compiled once per process, via NVRTC, and
// cached on disk by cortex/compute's CompileToPTX).
// ─────────────────────────────────────────────────────────────────────

const bitnetCUDASource = `
// half_to_float: manual IEEE-754 binary16 -> binary32 decode (normal,
// subnormal, zero, inf, nan) — written out by hand rather than
// #include <cuda_fp16.h> so this source has zero header dependency
// beyond NVRTC's built-in device intrinsics (__uint_as_float), which
// keeps the "no nvcc/MSVC, NVRTC only" story simple: nothing here
// depends on NVRTC's bundled/builtin-header resolution succeeding.
__device__ __forceinline__ float half_to_float(unsigned short h) {
    unsigned int sign = (unsigned int)(h & 0x8000u) << 16;
    unsigned int exp  = (h >> 10) & 0x1Fu;
    unsigned int mant = h & 0x3FFu;
    unsigned int bits;
    if (exp == 0u) {
        if (mant == 0u) {
            bits = sign;
        } else {
            int e = -1;
            unsigned int m = mant;
            do { e++; m <<= 1; } while ((m & 0x400u) == 0u);
            m &= 0x3FFu;
            unsigned int fexp = (unsigned int)(127 - 15 - e);
            bits = sign | (fexp << 23) | (m << 13);
        }
    } else if (exp == 0x1Fu) {
        bits = sign | 0x7F800000u | (mant << 13);
    } else {
        unsigned int fexp = exp - 15u + 127u;
        bits = sign | (fexp << 23) | (mant << 13);
    }
    return __uint_as_float(bits);
}

extern "C" {

// rmsnorm_kernel: single block, blockDim.x MUST be 256 (matches sdata's
// fixed size) — matches RMSNorm/rmsNormInto: sum-of-squares accumulated
// in double, exactly like the CPU loop, just tree-reduced instead of
// sequential (order-of-summation difference bounded well under 1e-6 for
// these dimensions — see bitnet_cuda_test.go).
__global__ void rmsnorm_kernel(const float* x, int n, const float* weight, double eps, float* out) {
    __shared__ double sdata[256];
    int tid = threadIdx.x;
    double local = 0.0;
    for (int i = tid; i < n; i += blockDim.x) {
        double v = (double)x[i];
        local += v * v;
    }
    sdata[tid] = local;
    __syncthreads();
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) sdata[tid] += sdata[tid + s];
        __syncthreads();
    }
    __shared__ double invStd;
    if (tid == 0) {
        double variance = sdata[0] / (double)n;
        invStd = 1.0 / sqrt(variance + eps);
    }
    __syncthreads();
    for (int i = tid; i < n; i += blockDim.x) {
        double v = (double)x[i];
        out[i] = weight[i] * (float)(v * invStd);
    }
}

// act_quant_kernel: single block, blockDim.x MUST be 256 — matches
// quantizeActivationsInt32 exactly: maxAbs (order-independent, so the
// tree reduction is exact, not just close), clamp to >=1e-5f,
// scale=127/maxAbs, round-half-away-from-zero via truncating float->int
// cast, clamp to [-128,127].
__global__ void act_quant_kernel(const float* x, int n, signed char* qx, float* xScaleOut) {
    __shared__ float sdata[256];
    int tid = threadIdx.x;
    float localMax = 0.0f;
    for (int i = tid; i < n; i += blockDim.x) {
        float a = x[i];
        if (a < 0.0f) a = -a;
        if (a > localMax) localMax = a;
    }
    sdata[tid] = localMax;
    __syncthreads();
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) { if (sdata[tid + s] > sdata[tid]) sdata[tid] = sdata[tid + s]; }
        __syncthreads();
    }
    __shared__ float quantScale;
    if (tid == 0) {
        float maxAbs = sdata[0];
        if (maxAbs < 1e-5f) maxAbs = 1e-5f;
        quantScale = 127.0f / maxAbs;
        *xScaleOut = maxAbs / 127.0f;
    }
    __syncthreads();
    for (int i = tid; i < n; i += blockDim.x) {
        float q = x[i] * quantScale;
        int r;
        if (q >= 0.0f) r = (int)(q + 0.5f);
        else r = (int)(q - 0.5f);
        if (r > 127) r = 127;
        else if (r < -128) r = -128;
        qx[i] = (signed char)r;
    }
}

// bitlinear_gemv_kernel: one block per output row (blockIdx.x), blockDim.x
// MUST be 128 (matches sdata's fixed size). Unpacks TernaryTile exactly
// as ternary.go's PackTernaryTile/tileSignMask16 (bitnet_linear.go):
// R=signLo, G=maskLo, B=signHi, A=maskHi bytes of the little-endian
// uint32, merged into 16-bit sign/mask words so bit i (0..15) maps to
// weight i within the tile. Padding positions beyond a row's logical
// In (within the last tile) are guaranteed mask=0 by SetRow, so qx's
// corresponding bytes are never read regardless of their contents.
// int32 accumulation is exact and order-independent (see
// dotTernaryInt8's doc comment) — the per-thread partial sums and the
// block reduction below reproduce the CPU's dot product bit-for-bit.
// The rescale order ((float)acc * xScale) * scale matches
// bitLinearForwardRows' single-row tail-branch order exactly.
__global__ void bitlinear_gemv_kernel(
    const unsigned int* tiles, int tilesPerRow,
    const signed char* qx, const float* xScalePtr, float scale,
    float* y)
{
    const unsigned int* rowTiles = tiles + (size_t)blockIdx.x * tilesPerRow;
    int tid = threadIdx.x;
    int acc = 0;
    for (int t = tid; t < tilesPerRow; t += blockDim.x) {
        unsigned int tw = rowTiles[t];
        unsigned int signLo = tw & 0xFFu;
        unsigned int maskLo = (tw >> 8) & 0xFFu;
        unsigned int signHi = (tw >> 16) & 0xFFu;
        unsigned int maskHi = (tw >> 24) & 0xFFu;
        unsigned int sign16 = signLo | (signHi << 8);
        unsigned int mask16 = maskLo | (maskHi << 8);
        int base = t * 16;
        #pragma unroll
        for (int i = 0; i < 16; i++) {
            unsigned int bit = 1u << i;
            if (mask16 & bit) {
                int w = (sign16 & bit) ? -1 : 1;
                acc += w * (int)qx[base + i];
            }
        }
    }
    __shared__ int sdata[128];
    sdata[tid] = acc;
    __syncthreads();
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) sdata[tid] += sdata[tid + s];
        __syncthreads();
    }
    if (tid == 0) {
        float yv = (float)sdata[0] * (*xScalePtr);
        y[blockIdx.x] = yv * scale;
    }
}

// relu2_mul_kernel: elementwise, matches the relu(gate)^2*up loop in
// bitnetMLP/decodeStepMLP exactly (independent per element, so ordering
// is a non-issue).
__global__ void relu2_mul_kernel(const float* gate, const float* up, int n, float* out) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float r = gate[i];
        if (r < 0.0f) r = 0.0f;
        out[i] = r * r * up[i];
    }
}

// add_kernel: elementwise out=a+b — the residual-connection glue
// (x+attnOut, resid+ffnOut) the task's named kernel list doesn't call
// out separately but a complete decode step needs.
__global__ void add_kernel(const float* a, const float* b, int n, float* out) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) out[i] = a[i] + b[i];
}

// rope_half_kernel: one block per head (blockIdx.x), blockDim.x == hd/2.
// Matches applyRoPEHalf exactly: rotate_half(x)=concat(-x[half:],x[:half]),
// x_embed = x*cos + rotate_half(x)*sin — computed per (head,i) pair by a
// single thread reading both original values into registers before
// writing either output slot, so no cross-thread race within a head.
__global__ void rope_half_kernel(float* x, int hd, const float* cosRow, const float* sinRow) {
    int half = hd / 2;
    int i = threadIdx.x;
    float* xh = x + (size_t)blockIdx.x * hd;
    float xi = xh[i];
    float xih = xh[i + half];
    xh[i]        = xi  * cosRow[i]        + (-xih) * sinRow[i];
    xh[i + half] = xih * cosRow[i + half] +   xi    * sinRow[i + half];
}

// attn_decode_kernel: one block per query head (blockIdx.x), blockDim.x
// MUST be 256 (matches sred's fixed size). GQA: query head h reads KV
// head h/(nHeads/nKV) — matches decodeStepAttention's kvh computation.
// scratch is a caller-provided [nHeads][maxSeq] scratch buffer (avoids
// needing dynamic/oversized shared memory for scores up to
// Cfg.MaxSeqLen wide). Reproduces decodeStepAttention's three passes —
// scaled dot products, max-subtract softmax, weighted V sum — in the
// same arithmetic order per s (weights[s]=e; ...; w=weights[s]*inv;
// out[k]+=w*v[k]).
__global__ void attn_decode_kernel(
    const float* q, const float* Kc, const float* Vc,
    int pos, int nHeads, int nKV, int hd, int kvDim, float scale,
    float* scratch, int maxSeq, float* attnOut)
{
    int h = blockIdx.x;
    int nRep = nHeads / nKV;
    int kvh = h / nRep;
    const float* qv = q + (size_t)h * hd;
    float* srow = scratch + (size_t)h * maxSeq;
    int tid = threadIdx.x;
    int bs = blockDim.x;

    for (int s = tid; s <= pos; s += bs) {
        const float* kv = Kc + (size_t)s * kvDim + kvh * hd;
        float dot = 0.0f;
        for (int k = 0; k < hd; k++) dot += qv[k] * kv[k];
        srow[s] = dot * scale;
    }
    __syncthreads();

    __shared__ float sred[256];
    float localMax = -3.0e38f;
    for (int s = tid; s <= pos; s += bs) {
        if (srow[s] > localMax) localMax = srow[s];
    }
    sred[tid] = localMax;
    __syncthreads();
    for (int st = bs / 2; st > 0; st >>= 1) {
        if (tid < st) { if (sred[tid + st] > sred[tid]) sred[tid] = sred[tid + st]; }
        __syncthreads();
    }
    float maxScore = sred[0];
    __syncthreads();

    float localSum = 0.0f;
    for (int s = tid; s <= pos; s += bs) {
        float e = expf(srow[s] - maxScore);
        srow[s] = e;
        localSum += e;
    }
    sred[tid] = localSum;
    __syncthreads();
    for (int st = bs / 2; st > 0; st >>= 1) {
        if (tid < st) sred[tid] += sred[tid + st];
        __syncthreads();
    }
    __shared__ float invSum;
    if (tid == 0) invSum = 1.0f / sred[0];
    __syncthreads();

    float* outp = attnOut + (size_t)h * hd;
    for (int k = tid; k < hd; k += bs) {
        float acc = 0.0f;
        for (int s = 0; s <= pos; s++) {
            float w = srow[s] * invSum;
            acc += w * Vc[(size_t)s * kvDim + kvh * hd + k];
        }
        outp[k] = acc;
    }
}

// lm_head_dot_kernel: one WARP per vocab row (blockDim.x MUST be a
// multiple of 32 — cudaLMHeadBlock/cudaLMHeadWarpsPerBlock below), each
// of the 32 lanes striding over d with stride 32 and warp-shuffle
// reducing the partial sums. embedFp16 is the tied embedding table
// uploaded as binary16 (see file doc comment for the documented,
// non-compounding precision trade this makes).
//
// An earlier one-thread-per-row version (grid-stride over vocab, each
// thread doing the full length-d loop alone) measured at 84.6% of a
// whole 30-layer decode step's wall time (192ms of 228ms, real 2.4B
// checkpoint, profiled via TestCUDAProfileStep) despite doing far less
// arithmetic than the 210 ternary GEMVs combined (21.8ms) — because
// adjacent threads there read DIFFERENT, d*2-bytes-apart rows
// (thread v and v+1 are 5120 bytes apart for d=2560), so a warp's 32
// lanes never coalesce into one memory transaction. Here, for a FIXED
// row, lane L reads embedFp16[row*d + L], embedFp16[row*d + L+32], ... —
// adjacent lanes read ADJACENT halfwords, a fully coalesced 64-byte
// transaction per step of the strided loop — the same access-pattern
// fix bitlinear_gemv_kernel already applied by construction (its
// per-block reduction likewise has adjacent threads touch adjacent
// tiles).
__global__ void lm_head_dot_kernel(const unsigned short* embedFp16, const float* h, int d, int vocab, float* logits) {
    int lane = threadIdx.x & 31;
    int warpInBlock = threadIdx.x >> 5;
    int warpsPerBlock = blockDim.x >> 5;
    int row = blockIdx.x * warpsPerBlock + warpInBlock;
    if (row >= vocab) return;
    const unsigned short* rowPtr = embedFp16 + (size_t)row * d;
    float sum = 0.0f;
    for (int k = lane; k < d; k += 32) {
        sum += half_to_float(rowPtr[k]) * h[k];
    }
    #pragma unroll
    for (int offset = 16; offset > 0; offset >>= 1) {
        sum += __shfl_down_sync(0xFFFFFFFFu, sum, offset);
    }
    if (lane == 0) logits[row] = sum;
}

// argmax_partial_kernel: grid-stride over n, each block reduces to one
// (value,index) pair with EARLIEST-INDEX tie-break on equal values
// (matches argmaxFloat32's "if row[v] > bestVal" strict-greater
// semantics exactly, including across the cross-thread combine step,
// not just within one thread's local scan). The host does the final
// reduction over the (small) per-block outputs — see
// BitNetCUDADecoder.Argmax.
__global__ void argmax_partial_kernel(const float* logits, int n, float* outVal, int* outIdx) {
    __shared__ float sVal[256];
    __shared__ int sIdx[256];
    int tid = threadIdx.x;
    int stride = blockDim.x * gridDim.x;
    float bestVal = -3.0e38f;
    int bestIdx = 0;
    for (int i = blockIdx.x * blockDim.x + tid; i < n; i += stride) {
        float v = logits[i];
        if (v > bestVal) { bestVal = v; bestIdx = i; }
    }
    sVal[tid] = bestVal;
    sIdx[tid] = bestIdx;
    __syncthreads();
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            float ov = sVal[tid + s];
            int oi = sIdx[tid + s];
            if (ov > sVal[tid] || (ov == sVal[tid] && oi < sIdx[tid])) {
                sVal[tid] = ov;
                sIdx[tid] = oi;
            }
        }
        __syncthreads();
    }
    if (tid == 0) {
        outVal[blockIdx.x] = sVal[0];
        outIdx[blockIdx.x] = sIdx[0];
    }
}

} // extern "C"
`

// Fixed launch geometry — every shared-memory array size in the kernel
// source above is hard-coded to match exactly one of these, so these
// constants and the kernel source must change together.
const (
	cudaRMSNormBlock        = 256
	cudaActQuantBlock       = 256
	cudaGEMVBlock           = 128
	cudaAttnBlock           = 256
	cudaElemBlock           = 256
	cudaLMHeadBlock         = 256 // must stay a multiple of 32 — see lm_head_dot_kernel
	cudaLMHeadWarpsPerBlock = cudaLMHeadBlock / 32
	cudaArgmaxBlocks        = 64
	cudaArgmaxBlock         = 256
)

// ─────────────────────────────────────────────────────────────────────
// float32 -> binary16 (round-to-nearest-even) — host-side, for the
// lm_head embedding upload (uploadEmbedFP16). Written by hand rather
// than pulled from a dependency: the standard library has no float16
// type, and this is the one place in the CUDA path that needs the
// conversion.
// ─────────────────────────────────────────────────────────────────────

func float32ToFloat16Bits(f float32) uint16 {
	bits := math.Float32bits(f)
	sign := uint16((bits >> 16) & 0x8000)
	exp := int32((bits>>23)&0xFF) - 127 + 15
	mant := bits & 0x7FFFFF

	if (bits>>23)&0xFF == 0xFF { // inf/nan
		if mant != 0 {
			return sign | 0x7C00 | 0x0200 // quiet NaN
		}
		return sign | 0x7C00 // inf
	}
	if exp >= 0x1F {
		return sign | 0x7C00 // overflow -> inf
	}
	if exp <= 0 {
		if exp < -10 {
			return sign // underflow -> signed zero
		}
		// Subnormal half: shift the implicit-leading-1 mantissa right by
		// (14-exp), rounding to nearest-even.
		m := mant | 0x800000
		shift := uint(14 - exp)
		half := uint32(1) << (shift - 1)
		r := m >> shift
		rem := m & ((half << 1) - 1)
		if rem > half || (rem == half && r&1 != 0) {
			r++
		}
		return sign | uint16(r)
	}
	// Normal range: truncate the 23-bit mantissa to 10 bits, rounding to
	// nearest-even, with mantissa overflow bumping the exponent.
	m := mant >> 13
	rem := mant & 0x1FFF
	const half = uint32(1) << 12
	if rem > half || (rem == half && m&1 != 0) {
		m++
		if m == 0x400 {
			m = 0
			exp++
			if exp >= 0x1F {
				return sign | 0x7C00
			}
		}
	}
	return sign | uint16(exp<<10) | uint16(m)
}

// ─────────────────────────────────────────────────────────────────────
// Device buffer upload/alloc helpers.
// ─────────────────────────────────────────────────────────────────────

func uploadFloat32(data []float32) (*compute.DeviceBuffer, error) {
	if len(data) == 0 {
		return nil, errors.New("cortex: uploadFloat32: empty data")
	}
	buf, err := compute.AllocDevice(len(data) * 4)
	if err != nil {
		return nil, err
	}
	if err := buf.CopyFromHost(unsafe.Pointer(&data[0]), len(data)*4); err != nil {
		buf.Free()
		return nil, err
	}
	return buf, nil
}

func uploadUint32(data []uint32) (*compute.DeviceBuffer, error) {
	if len(data) == 0 {
		return nil, errors.New("cortex: uploadUint32: empty data")
	}
	buf, err := compute.AllocDevice(len(data) * 4)
	if err != nil {
		return nil, err
	}
	if err := buf.CopyFromHost(unsafe.Pointer(&data[0]), len(data)*4); err != nil {
		buf.Free()
		return nil, err
	}
	return buf, nil
}

func uploadUint16(data []uint16) (*compute.DeviceBuffer, error) {
	if len(data) == 0 {
		return nil, errors.New("cortex: uploadUint16: empty data")
	}
	buf, err := compute.AllocDevice(len(data) * 2)
	if err != nil {
		return nil, err
	}
	if err := buf.CopyFromHost(unsafe.Pointer(&data[0]), len(data)*2); err != nil {
		buf.Free()
		return nil, err
	}
	return buf, nil
}

func allocFloat32(n int) (*compute.DeviceBuffer, error) { return compute.AllocDevice(n * 4) }
func allocInt8(n int) (*compute.DeviceBuffer, error)    { return compute.AllocDevice(n) }
func allocInt32(n int) (*compute.DeviceBuffer, error)   { return compute.AllocDevice(n * 4) }

// tilesToUint32 reinterprets a BitLinear's packed TernaryTile slice as
// []uint32 with no copy — TernaryTile's underlying type IS uint32 (see
// ternary.go), and its RGBA32 packing is already exactly the layout
// bitlinear_gemv_kernel unpacks, so the device receives the identical
// bytes SetRow/PackTernaryTile produced.
func tilesToUint32(tiles []TernaryTile) []uint32 {
	if len(tiles) == 0 {
		return nil
	}
	return unsafe.Slice((*uint32)(unsafe.Pointer(&tiles[0])), len(tiles))
}

// uploadEmbedFP16 flattens m.Embed (VocabSize*EmbedDim float32,
// row-major) into a binary16 buffer of the same shape and uploads it —
// see the file doc comment's PRECISION section for why this is scoped
// to lm_head only, not the input-embedding lookup.
func uploadEmbedFP16(embed []float32) (*compute.DeviceBuffer, error) {
	half := make([]uint16, len(embed))
	for i, f := range embed {
		half[i] = float32ToFloat16Bits(f)
	}
	return uploadUint16(half)
}

// ─────────────────────────────────────────────────────────────────────
// BitNetCUDADecoder
// ─────────────────────────────────────────────────────────────────────

// layerCUDAWeights holds one decoder layer's device-resident state:
// seven packed-ternary weight matrices (raw uint32 tiles, uploaded once
// and never touched again — the "0.6 GB read per token" the whole design
// exists to make a pure device-memory read instead of a PCIe transfer),
// their per-tensor dequant scales (plain host float32s — known at
// upload time, passed as literal kernel args, never need a device
// round trip), and the four RMSNorm weight vectors.
type layerCUDAWeights struct {
	tilesQ, tilesK, tilesV, tilesO             *compute.DeviceBuffer
	tilesGate, tilesUp, tilesDown              *compute.DeviceBuffer
	tprQ, tprK, tprV, tprO                     int32
	tprGate, tprUp, tprDown                    int32
	outQ, outK, outV, outO                     int32
	outGate, outUp, outDown                    int32
	scaleQ, scaleK, scaleV, scaleO             float32
	scaleGate, scaleUp, scaleDown              float32
	attnNorm, ffnNorm, attnSubNorm, ffnSubNorm *compute.DeviceBuffer
}

// BitNetCUDADecoder runs BitNetModel decoding entirely on the GPU: every
// BitLinear weight, the KV cache, and the tied embedding table (as
// fp16, for lm_head) are uploaded once at construction; Prefill/Step
// then only ever transfer the current token's embedding row in (a few
// KB) and the resulting logits out (VocabSize*4 bytes) — see the file
// doc comment. Not safe for concurrent use, same contract as
// BitNetDecoder (bitnet_decode.go): one decoder owns one in-progress
// sequence's KV cache.
type BitNetCUDADecoder struct {
	m   *BitNetModel
	mod *compute.Module

	layers    []layerCUDAWeights
	finalNorm *compute.DeviceBuffer
	embedFP16 *compute.DeviceBuffer

	kCache, vCache     *compute.DeviceBuffer
	cosTable, sinTable *compute.DeviceBuffer

	// Scratch, reused across every layer of every step — sized once at
	// construction, matching bitNetStepBuf's role in the CPU decoder.
	xBuf, residBuf, normedBuf, normed2Buf *compute.DeviceBuffer // EmbedDim
	qBuf                                  *compute.DeviceBuffer // EmbedDim
	attnRawBuf, attnOutBuf, oOutBuf       *compute.DeviceBuffer // EmbedDim
	gateBuf, upBuf, mlpRowBuf             *compute.DeviceBuffer // FFNDim
	downOutBuf                            *compute.DeviceBuffer // EmbedDim
	qxEmbedBuf, qxFFNBuf                  *compute.DeviceBuffer // int8
	xScaleBuf                             *compute.DeviceBuffer // 1 float32
	attnScratch                           *compute.DeviceBuffer // NumHeads*MaxSeqLen float32
	logitsBuf                             *compute.DeviceBuffer // VocabSize float32
	argValBuf                             *compute.DeviceBuffer // cudaArgmaxBlocks float32
	argIdxBuf                             *compute.DeviceBuffer // cudaArgmaxBlocks int32

	hd, kvDim int
	pos       int

	logitsHost []float32 // reused host-side landing buffer for the D2H logits copy
}

// NewBitNetCUDADecoder compiles the CUDA kernels, uploads every
// BitLinear weight/RMSNorm vector/embedding for m, allocates the KV
// cache for m.Cfg.MaxSeqLen, and returns a decoder ready for Prefill.
// On any failure, everything already allocated is freed before
// returning the error (no partial/leaked device state).
func NewBitNetCUDADecoder(m *BitNetModel) (dec *BitNetCUDADecoder, err error) {
	cfg := m.Cfg
	hd := cfg.headDim()
	kvDim := cfg.NumKVHeads * hd

	mod, err := compute.CompileKernels(bitnetCUDASource)
	if err != nil {
		return nil, fmt.Errorf("compile kernels: %w", err)
	}

	d := &BitNetCUDADecoder{m: m, mod: mod, hd: hd, kvDim: kvDim}

	// On any error from here on, free whatever was already allocated
	// before propagating — defer runs after the named return `err` is
	// set by an early `return nil, ...`, so we can inspect it.
	defer func() {
		if err != nil {
			d.Close()
			dec = nil
		}
	}()

	cos, sin := ropeCosSin(cfg.MaxSeqLen, hd, cfg.RopeTheta)
	cosFlat := make([]float32, cfg.MaxSeqLen*hd)
	sinFlat := make([]float32, cfg.MaxSeqLen*hd)
	for t := 0; t < cfg.MaxSeqLen; t++ {
		copy(cosFlat[t*hd:(t+1)*hd], cos[t])
		copy(sinFlat[t*hd:(t+1)*hd], sin[t])
	}
	if d.cosTable, err = uploadFloat32(cosFlat); err != nil {
		return nil, fmt.Errorf("upload rope cos table: %w", err)
	}
	if d.sinTable, err = uploadFloat32(sinFlat); err != nil {
		return nil, fmt.Errorf("upload rope sin table: %w", err)
	}

	if d.finalNorm, err = uploadFloat32(m.FinalNorm); err != nil {
		return nil, fmt.Errorf("upload final norm: %w", err)
	}
	if d.embedFP16, err = uploadEmbedFP16(m.Embed); err != nil {
		return nil, fmt.Errorf("upload fp16 embedding: %w", err)
	}

	kvBytes := cfg.NumLayers * cfg.MaxSeqLen * kvDim * 4
	if d.kCache, err = compute.AllocDevice(kvBytes); err != nil {
		return nil, fmt.Errorf("alloc K cache: %w", err)
	}
	if d.vCache, err = compute.AllocDevice(kvBytes); err != nil {
		return nil, fmt.Errorf("alloc V cache: %w", err)
	}

	uploadLinear := func(l *BitLinear) (*compute.DeviceBuffer, int32, int32, float32, error) {
		buf, e := uploadUint32(tilesToUint32(l.Tiles))
		if e != nil {
			return nil, 0, 0, 0, e
		}
		tpr := int32((l.In + 15) / 16)
		return buf, tpr, int32(l.Out), l.Scale, nil
	}

	d.layers = make([]layerCUDAWeights, cfg.NumLayers)
	for li, layer := range m.Layers {
		lw := &d.layers[li]
		var e error
		if lw.tilesQ, lw.tprQ, lw.outQ, lw.scaleQ, e = uploadLinear(layer.Q); e != nil {
			return nil, fmt.Errorf("layer %d upload Q: %w", li, e)
		}
		if lw.tilesK, lw.tprK, lw.outK, lw.scaleK, e = uploadLinear(layer.K); e != nil {
			return nil, fmt.Errorf("layer %d upload K: %w", li, e)
		}
		if lw.tilesV, lw.tprV, lw.outV, lw.scaleV, e = uploadLinear(layer.V); e != nil {
			return nil, fmt.Errorf("layer %d upload V: %w", li, e)
		}
		if lw.tilesO, lw.tprO, lw.outO, lw.scaleO, e = uploadLinear(layer.O); e != nil {
			return nil, fmt.Errorf("layer %d upload O: %w", li, e)
		}
		if lw.tilesGate, lw.tprGate, lw.outGate, lw.scaleGate, e = uploadLinear(layer.Gate); e != nil {
			return nil, fmt.Errorf("layer %d upload Gate: %w", li, e)
		}
		if lw.tilesUp, lw.tprUp, lw.outUp, lw.scaleUp, e = uploadLinear(layer.Up); e != nil {
			return nil, fmt.Errorf("layer %d upload Up: %w", li, e)
		}
		if lw.tilesDown, lw.tprDown, lw.outDown, lw.scaleDown, e = uploadLinear(layer.Down); e != nil {
			return nil, fmt.Errorf("layer %d upload Down: %w", li, e)
		}
		if lw.attnNorm, e = uploadFloat32(layer.AttnNorm); e != nil {
			return nil, fmt.Errorf("layer %d upload attn_norm: %w", li, e)
		}
		if lw.ffnNorm, e = uploadFloat32(layer.FFNNorm); e != nil {
			return nil, fmt.Errorf("layer %d upload ffn_norm: %w", li, e)
		}
		if lw.attnSubNorm, e = uploadFloat32(layer.AttnSubNorm); e != nil {
			return nil, fmt.Errorf("layer %d upload attn_sub_norm: %w", li, e)
		}
		if lw.ffnSubNorm, e = uploadFloat32(layer.FFNSubNorm); e != nil {
			return nil, fmt.Errorf("layer %d upload ffn_sub_norm: %w", li, e)
		}
	}

	dModel := cfg.EmbedDim
	allocs := []struct {
		dst  **compute.DeviceBuffer
		n    int
		int8 bool
	}{
		{&d.xBuf, dModel, false},
		{&d.residBuf, dModel, false},
		{&d.normedBuf, dModel, false},
		{&d.normed2Buf, dModel, false},
		{&d.qBuf, dModel, false},
		{&d.attnRawBuf, dModel, false},
		{&d.attnOutBuf, dModel, false},
		{&d.oOutBuf, dModel, false},
		{&d.gateBuf, cfg.FFNDim, false},
		{&d.upBuf, cfg.FFNDim, false},
		{&d.mlpRowBuf, cfg.FFNDim, false},
		{&d.downOutBuf, dModel, false},
	}
	for _, a := range allocs {
		if *a.dst, err = allocFloat32(a.n); err != nil {
			return nil, fmt.Errorf("alloc scratch: %w", err)
		}
	}
	tprEmbed := (dModel + 15) / 16
	tprFFN := (cfg.FFNDim + 15) / 16
	if d.qxEmbedBuf, err = allocInt8(tprEmbed * 16); err != nil {
		return nil, fmt.Errorf("alloc qxEmbed: %w", err)
	}
	if d.qxFFNBuf, err = allocInt8(tprFFN * 16); err != nil {
		return nil, fmt.Errorf("alloc qxFFN: %w", err)
	}
	if d.xScaleBuf, err = allocFloat32(1); err != nil {
		return nil, fmt.Errorf("alloc xScale: %w", err)
	}
	if d.attnScratch, err = allocFloat32(cfg.NumHeads * cfg.MaxSeqLen); err != nil {
		return nil, fmt.Errorf("alloc attn scratch: %w", err)
	}
	if d.logitsBuf, err = allocFloat32(cfg.VocabSize); err != nil {
		return nil, fmt.Errorf("alloc logits: %w", err)
	}
	if d.argValBuf, err = allocFloat32(cudaArgmaxBlocks); err != nil {
		return nil, fmt.Errorf("alloc argmax vals: %w", err)
	}
	if d.argIdxBuf, err = allocInt32(cudaArgmaxBlocks); err != nil {
		return nil, fmt.Errorf("alloc argmax idxs: %w", err)
	}

	d.logitsHost = make([]float32, cfg.VocabSize)
	return d, nil
}

// ─────────────────────────────────────────────────────────────────────
// Per-kernel launch helpers.
// ─────────────────────────────────────────────────────────────────────

func (d *BitNetCUDADecoder) rmsnorm(x *compute.DeviceBuffer, n int, weight *compute.DeviceBuffer, eps float64, out *compute.DeviceBuffer) error {
	args := compute.NewKernelArgs().AddDevicePtr(x).AddInt32(int32(n)).AddDevicePtr(weight).AddFloat64(eps).AddDevicePtr(out)
	defer args.Release()
	return d.mod.Launch("rmsnorm_kernel", [3]uint32{1, 1, 1}, [3]uint32{cudaRMSNormBlock, 1, 1}, 0, args)
}

func (d *BitNetCUDADecoder) actQuant(x *compute.DeviceBuffer, n int, qx *compute.DeviceBuffer) error {
	args := compute.NewKernelArgs().AddDevicePtr(x).AddInt32(int32(n)).AddDevicePtr(qx).AddDevicePtr(d.xScaleBuf)
	defer args.Release()
	return d.mod.Launch("act_quant_kernel", [3]uint32{1, 1, 1}, [3]uint32{cudaActQuantBlock, 1, 1}, 0, args)
}

// gemvOut runs bitlinear_gemv_kernel writing its `out`-row output
// starting at byte offset yByteOffset within yBuf — used directly for
// K/V (writing straight into their KV-cache row, see file doc comment)
// and with yByteOffset=0 (via gemv below) for everything else.
func (d *BitNetCUDADecoder) gemvOut(tiles *compute.DeviceBuffer, tpr, out int32, qx *compute.DeviceBuffer, scale float32, yBuf *compute.DeviceBuffer, yByteOffset int) error {
	args := compute.NewKernelArgs().
		AddDevicePtr(tiles).
		AddInt32(tpr).
		AddDevicePtr(qx).
		AddDevicePtr(d.xScaleBuf).
		AddFloat32(scale).
		AddDevicePtrOffset(yBuf, yByteOffset)
	defer args.Release()
	return d.mod.Launch("bitlinear_gemv_kernel", [3]uint32{uint32(out), 1, 1}, [3]uint32{cudaGEMVBlock, 1, 1}, 0, args)
}

func (d *BitNetCUDADecoder) gemv(tiles *compute.DeviceBuffer, tpr, out int32, qx *compute.DeviceBuffer, scale float32, y *compute.DeviceBuffer) error {
	return d.gemvOut(tiles, tpr, out, qx, scale, y, 0)
}

func (d *BitNetCUDADecoder) relu2(gate, up *compute.DeviceBuffer, n int, out *compute.DeviceBuffer) error {
	args := compute.NewKernelArgs().AddDevicePtr(gate).AddDevicePtr(up).AddInt32(int32(n)).AddDevicePtr(out)
	defer args.Release()
	grid := uint32((n + cudaElemBlock - 1) / cudaElemBlock)
	return d.mod.Launch("relu2_mul_kernel", [3]uint32{grid, 1, 1}, [3]uint32{cudaElemBlock, 1, 1}, 0, args)
}

func (d *BitNetCUDADecoder) add(a, b *compute.DeviceBuffer, n int, out *compute.DeviceBuffer) error {
	args := compute.NewKernelArgs().AddDevicePtr(a).AddDevicePtr(b).AddInt32(int32(n)).AddDevicePtr(out)
	defer args.Release()
	grid := uint32((n + cudaElemBlock - 1) / cudaElemBlock)
	return d.mod.Launch("add_kernel", [3]uint32{grid, 1, 1}, [3]uint32{cudaElemBlock, 1, 1}, 0, args)
}

// ropeHalf applies RoPE in place to numHeads*hd floats starting at byte
// offset byteOffset within buf (0 for the scratch Q buffer; a KV-cache
// row offset for K — see file doc comment) using the cos/sin row at
// absolute position `pos`.
func (d *BitNetCUDADecoder) ropeHalf(buf *compute.DeviceBuffer, byteOffset int, numHeads, pos int) error {
	rowOff := pos * d.hd * 4
	args := compute.NewKernelArgs().
		AddDevicePtrOffset(buf, byteOffset).
		AddInt32(int32(d.hd)).
		AddDevicePtrOffset(d.cosTable, rowOff).
		AddDevicePtrOffset(d.sinTable, rowOff)
	defer args.Release()
	return d.mod.Launch("rope_half_kernel", [3]uint32{uint32(numHeads), 1, 1}, [3]uint32{uint32(d.hd / 2), 1, 1}, 0, args)
}

func (d *BitNetCUDADecoder) attnDecode(li, pos int) error {
	cfg := d.m.Cfg
	layerOff := li * cfg.MaxSeqLen * d.kvDim * 4
	scale := float32(1.0 / math.Sqrt(float64(d.hd)))
	args := compute.NewKernelArgs().
		AddDevicePtr(d.qBuf).
		AddDevicePtrOffset(d.kCache, layerOff).
		AddDevicePtrOffset(d.vCache, layerOff).
		AddInt32(int32(pos)).
		AddInt32(int32(cfg.NumHeads)).
		AddInt32(int32(cfg.NumKVHeads)).
		AddInt32(int32(d.hd)).
		AddInt32(int32(d.kvDim)).
		AddFloat32(scale).
		AddDevicePtr(d.attnScratch).
		AddInt32(int32(cfg.MaxSeqLen)).
		AddDevicePtr(d.attnRawBuf)
	defer args.Release()
	return d.mod.Launch("attn_decode_kernel", [3]uint32{uint32(cfg.NumHeads), 1, 1}, [3]uint32{cudaAttnBlock, 1, 1}, 0, args)
}

// ─────────────────────────────────────────────────────────────────────
// The per-token decode pipeline.
// ─────────────────────────────────────────────────────────────────────

// uploadResidualRow H2D-copies a single Cfg.EmbedDim-length row directly
// into d.xBuf as the residual-stream input for the step about to run —
// shared by runStep (an embedding-TABLE lookup row) and runStepEmbed (a
// caller-supplied row, e.g. PrefillEmbeds's projected image/text
// embeddings): both are, from the kernels' point of view, just "the
// float32 vector that becomes x for this position", identical to how
// BitNetDecoder.PrefillEmbeds (bitnet_decode.go) uses a caller's row
// directly as x instead of going through Embed.
func (d *BitNetCUDADecoder) uploadResidualRow(row []float32) error {
	dModel := d.m.Cfg.EmbedDim
	if len(row) != dModel {
		return fmt.Errorf("row length %d, want %d", len(row), dModel)
	}
	return d.xBuf.CopyFromHost(unsafe.Pointer(&row[0]), dModel*4)
}

// runStep runs one full decoder pass for token `id` at absolute
// position `pos`, updating every layer's KV cache at row `pos`, and
// returns that position's VocabSize logits — the GPU-resident mirror of
// BitNetDecoder.Step (bitnet_decode.go), used for both Prefill (looped,
// keeping only the last call's result — "process the prompt token by
// token with the same kernels") and Step (single call).
func (d *BitNetCUDADecoder) runStep(id, pos int) ([]float32, error) {
	dModel := d.m.Cfg.EmbedDim

	// Exact float32 input embedding row, straight from the model's own
	// table — see file doc comment's PRECISION section for why this
	// deliberately does NOT go through the fp16 copy.
	row := d.m.Embed[id*dModel : (id+1)*dModel]
	if err := d.uploadResidualRow(row); err != nil {
		return nil, fmt.Errorf("copy input embedding: %w", err)
	}
	return d.runStepFromResidual(pos)
}

// runStepEmbed is runStep's PrefillEmbeds counterpart: row is used
// DIRECTLY as the residual-stream input for position pos (no embedding
// lookup) — the GPU-resident mirror of what BitNetDecoder.PrefillEmbeds
// does per row (bitnet_decode.go).
func (d *BitNetCUDADecoder) runStepEmbed(row []float32, pos int) ([]float32, error) {
	if err := d.uploadResidualRow(row); err != nil {
		return nil, fmt.Errorf("copy input embed row: %w", err)
	}
	return d.runStepFromResidual(pos)
}

// runStepFromResidual runs every layer plus final_norm/lm_head for the
// step at absolute position pos, assuming d.xBuf already holds that
// position's residual-stream input (put there by runStep's embedding
// lookup or runStepEmbed's caller-supplied row) — the part of a decode
// step shared by both entry points.
func (d *BitNetCUDADecoder) runStepFromResidual(pos int) ([]float32, error) {
	cfg := d.m.Cfg
	dModel := cfg.EmbedDim

	for li := 0; li < cfg.NumLayers; li++ {
		lw := &d.layers[li]

		if err := d.rmsnorm(d.xBuf, dModel, lw.attnNorm, cfg.RMSNormEps, d.normedBuf); err != nil {
			return nil, fmt.Errorf("layer %d attn_norm: %w", li, err)
		}
		if err := d.actQuant(d.normedBuf, dModel, d.qxEmbedBuf); err != nil {
			return nil, fmt.Errorf("layer %d act_quant(Q/K/V): %w", li, err)
		}
		if err := d.gemv(lw.tilesQ, lw.tprQ, lw.outQ, d.qxEmbedBuf, lw.scaleQ, d.qBuf); err != nil {
			return nil, fmt.Errorf("layer %d Q gemv: %w", li, err)
		}

		kvRowOff := (li*cfg.MaxSeqLen + pos) * d.kvDim * 4
		if err := d.gemvOut(lw.tilesK, lw.tprK, lw.outK, d.qxEmbedBuf, lw.scaleK, d.kCache, kvRowOff); err != nil {
			return nil, fmt.Errorf("layer %d K gemv: %w", li, err)
		}
		if err := d.gemvOut(lw.tilesV, lw.tprV, lw.outV, d.qxEmbedBuf, lw.scaleV, d.vCache, kvRowOff); err != nil {
			return nil, fmt.Errorf("layer %d V gemv: %w", li, err)
		}

		if err := d.ropeHalf(d.qBuf, 0, cfg.NumHeads, pos); err != nil {
			return nil, fmt.Errorf("layer %d rope(Q): %w", li, err)
		}
		if err := d.ropeHalf(d.kCache, kvRowOff, cfg.NumKVHeads, pos); err != nil {
			return nil, fmt.Errorf("layer %d rope(K): %w", li, err)
		}

		if err := d.attnDecode(li, pos); err != nil {
			return nil, fmt.Errorf("layer %d attn_decode: %w", li, err)
		}

		if err := d.rmsnorm(d.attnRawBuf, dModel, lw.attnSubNorm, cfg.RMSNormEps, d.attnOutBuf); err != nil {
			return nil, fmt.Errorf("layer %d attn_sub_norm: %w", li, err)
		}
		if err := d.actQuant(d.attnOutBuf, dModel, d.qxEmbedBuf); err != nil {
			return nil, fmt.Errorf("layer %d act_quant(O): %w", li, err)
		}
		if err := d.gemv(lw.tilesO, lw.tprO, lw.outO, d.qxEmbedBuf, lw.scaleO, d.oOutBuf); err != nil {
			return nil, fmt.Errorf("layer %d O gemv: %w", li, err)
		}

		if err := d.add(d.xBuf, d.oOutBuf, dModel, d.residBuf); err != nil {
			return nil, fmt.Errorf("layer %d resid1: %w", li, err)
		}

		if err := d.rmsnorm(d.residBuf, dModel, lw.ffnNorm, cfg.RMSNormEps, d.normed2Buf); err != nil {
			return nil, fmt.Errorf("layer %d ffn_norm: %w", li, err)
		}
		if err := d.actQuant(d.normed2Buf, dModel, d.qxEmbedBuf); err != nil {
			return nil, fmt.Errorf("layer %d act_quant(Gate/Up): %w", li, err)
		}
		if err := d.gemv(lw.tilesGate, lw.tprGate, lw.outGate, d.qxEmbedBuf, lw.scaleGate, d.gateBuf); err != nil {
			return nil, fmt.Errorf("layer %d Gate gemv: %w", li, err)
		}
		if err := d.gemv(lw.tilesUp, lw.tprUp, lw.outUp, d.qxEmbedBuf, lw.scaleUp, d.upBuf); err != nil {
			return nil, fmt.Errorf("layer %d Up gemv: %w", li, err)
		}

		if err := d.relu2(d.gateBuf, d.upBuf, cfg.FFNDim, d.mlpRowBuf); err != nil {
			return nil, fmt.Errorf("layer %d relu2: %w", li, err)
		}
		if err := d.rmsnorm(d.mlpRowBuf, cfg.FFNDim, lw.ffnSubNorm, cfg.RMSNormEps, d.mlpRowBuf); err != nil {
			return nil, fmt.Errorf("layer %d ffn_sub_norm: %w", li, err)
		}
		if err := d.actQuant(d.mlpRowBuf, cfg.FFNDim, d.qxFFNBuf); err != nil {
			return nil, fmt.Errorf("layer %d act_quant(Down): %w", li, err)
		}
		if err := d.gemv(lw.tilesDown, lw.tprDown, lw.outDown, d.qxFFNBuf, lw.scaleDown, d.downOutBuf); err != nil {
			return nil, fmt.Errorf("layer %d Down gemv: %w", li, err)
		}

		if err := d.add(d.residBuf, d.downOutBuf, dModel, d.xBuf); err != nil {
			return nil, fmt.Errorf("layer %d resid2: %w", li, err)
		}
	}

	if err := d.rmsnorm(d.xBuf, dModel, d.finalNorm, cfg.RMSNormEps, d.normedBuf); err != nil {
		return nil, fmt.Errorf("final_norm: %w", err)
	}

	args := compute.NewKernelArgs().
		AddDevicePtr(d.embedFP16).
		AddDevicePtr(d.normedBuf).
		AddInt32(int32(dModel)).
		AddInt32(int32(cfg.VocabSize)).
		AddDevicePtr(d.logitsBuf)
	grid := uint32((cfg.VocabSize + cudaLMHeadWarpsPerBlock - 1) / cudaLMHeadWarpsPerBlock)
	err := d.mod.Launch("lm_head_dot_kernel", [3]uint32{grid, 1, 1}, [3]uint32{cudaLMHeadBlock, 1, 1}, 0, args)
	args.Release()
	if err != nil {
		return nil, fmt.Errorf("lm_head: %w", err)
	}

	if err := d.logitsBuf.CopyToHost(unsafe.Pointer(&d.logitsHost[0]), cfg.VocabSize*4); err != nil {
		return nil, fmt.Errorf("copy logits to host: %w", err)
	}
	out := make([]float32, cfg.VocabSize)
	copy(out, d.logitsHost)
	return out, nil
}

// Len returns the number of tokens currently cached.
func (d *BitNetCUDADecoder) Len() int { return d.pos }

// Reset clears the position counter, letting a decoder be reused for a
// fresh sequence without re-uploading any weights. KV cache rows beyond
// the new pos=0 are never read again (attn_decode_kernel only ever
// reads rows [0,pos]), so no device memory needs to be cleared.
func (d *BitNetCUDADecoder) Reset() { d.pos = 0 }

// TruncateTo is BitNetDecoder.TruncateTo's GPU mirror: the resident KV
// cache is addressed by absolute position and attention reads rows
// [0, pos], so dropping the tail is just moving pos back — later Steps
// overwrite the stale rows in place. n must be within [0, Len()].
func (d *BitNetCUDADecoder) TruncateTo(n int) {
	if n < 0 || n > d.pos {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.TruncateTo(%d): cache holds %d positions", n, d.pos))
	}
	d.pos = n
}

// Prefill processes ids as one prompt, filling every layer's KV cache
// and returning the last position's logits. Panics (matching the GPU
// backend's established fail-loud precedent — see bitLinearGPUImpl.forward's
// doc comment — and BitNetDecoder.Prefill's own panic-on-misuse contract)
// on a CUDA error, on being called with an empty prompt, on being called
// twice without an intervening Reset, or on a prompt longer than
// Cfg.MaxSeqLen.
func (d *BitNetCUDADecoder) Prefill(ids []int) []float32 {
	if len(ids) == 0 {
		panic("cortex: BitNetCUDADecoder.Prefill: empty ids")
	}
	if d.pos != 0 {
		panic("cortex: BitNetCUDADecoder.Prefill: decoder already has cached state; call Reset first")
	}
	if len(ids) > d.m.Cfg.MaxSeqLen {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Prefill: %d ids exceeds Cfg.MaxSeqLen %d", len(ids), d.m.Cfg.MaxSeqLen))
	}
	var logits []float32
	for t, id := range ids {
		l, err := d.runStep(id, t)
		if err != nil {
			panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Prefill: %v", err))
		}
		logits = l
	}
	d.pos = len(ids)
	return logits
}

// PrefillEmbeds is the embeddings-level counterpart to Prefill(ids) — the
// CUDA-decoder mirror of BitNetDecoder.PrefillEmbeds (bitnet_decode.go):
// each row of embeds (length Cfg.EmbedDim) is used DIRECTLY as the
// residual-stream input of that position (via runStepEmbed's H2D copy
// into d.xBuf, the same buffer runStep's embedding-table lookup fills),
// instead of an id -> embedding-table lookup, so a caller that splices
// non-text-token embeddings (e.g. projected image tokens, see
// cmd/ilaria-see) into the row sequence gets the same GPU decoder
// behavior text-only prompts get via Prefill. Rows are processed
// sequentially, one runStepEmbed call per row — no batched prefill kernel,
// matching Prefill's own token-by-token loop. Returns the last row's
// logits exactly like BitNetDecoder.PrefillEmbeds. Panics (matching
// Prefill's and BitNetDecoder.PrefillEmbeds's own panic-on-misuse
// contracts) on a CUDA error, an empty embeds slice, a row whose length
// isn't Cfg.EmbedDim, being called with cached state already present
// (call Reset first), or more rows than Cfg.MaxSeqLen.
func (d *BitNetCUDADecoder) PrefillEmbeds(embeds [][]float32) []float32 {
	if len(embeds) == 0 {
		panic("cortex: BitNetCUDADecoder.PrefillEmbeds: empty embeds")
	}
	if d.pos != 0 {
		panic("cortex: BitNetCUDADecoder.PrefillEmbeds: decoder already has cached state; call Reset first")
	}
	if len(embeds) > d.m.Cfg.MaxSeqLen {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.PrefillEmbeds: %d rows exceeds Cfg.MaxSeqLen %d", len(embeds), d.m.Cfg.MaxSeqLen))
	}
	var logits []float32
	for t, row := range embeds {
		l, err := d.runStepEmbed(row, t)
		if err != nil {
			panic(fmt.Sprintf("cortex: BitNetCUDADecoder.PrefillEmbeds: %v", err))
		}
		logits = l
	}
	d.pos = len(embeds)
	return logits
}

// Step appends one new token to the cache and returns its logits.
// Prefill must have been called first. Panics on a CUDA error, on being
// called before Prefill, or if the new token would exceed Cfg.MaxSeqLen
// — mirroring BitNetDecoder.Step's contract exactly.
func (d *BitNetCUDADecoder) Step(id int) []float32 {
	if d.pos == 0 {
		panic("cortex: BitNetCUDADecoder.Step: no cached state; call Prefill first")
	}
	if d.pos >= d.m.Cfg.MaxSeqLen {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Step: position %d would exceed Cfg.MaxSeqLen %d", d.pos, d.m.Cfg.MaxSeqLen))
	}
	logits, err := d.runStep(id, d.pos)
	if err != nil {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Step: %v", err))
	}
	d.pos++
	return logits
}

// Argmax returns the argmax of the CURRENT logits (from the most recent
// Prefill/Step call) computed entirely on the device — a fast path for
// callers that only need the greedy next-token id and want to skip
// re-scanning the VocabSize-length host slice Prefill/Step already
// returned. Ties break toward the earliest (lowest) index, matching
// argmaxFloat32 (bitnet.go) exactly. Panics on a CUDA error or if called
// before any Prefill/Step.
func (d *BitNetCUDADecoder) Argmax() int {
	if d.pos == 0 {
		panic("cortex: BitNetCUDADecoder.Argmax: no logits yet; call Prefill first")
	}
	args := compute.NewKernelArgs().
		AddDevicePtr(d.logitsBuf).
		AddInt32(int32(d.m.Cfg.VocabSize)).
		AddDevicePtr(d.argValBuf).
		AddDevicePtr(d.argIdxBuf)
	err := d.mod.Launch("argmax_partial_kernel", [3]uint32{cudaArgmaxBlocks, 1, 1}, [3]uint32{cudaArgmaxBlock, 1, 1}, 0, args)
	args.Release()
	if err != nil {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Argmax: %v", err))
	}

	vals := make([]float32, cudaArgmaxBlocks)
	idxs := make([]int32, cudaArgmaxBlocks)
	if err := d.argValBuf.CopyToHost(unsafe.Pointer(&vals[0]), cudaArgmaxBlocks*4); err != nil {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Argmax: %v", err))
	}
	if err := d.argIdxBuf.CopyToHost(unsafe.Pointer(&idxs[0]), cudaArgmaxBlocks*4); err != nil {
		panic(fmt.Sprintf("cortex: BitNetCUDADecoder.Argmax: %v", err))
	}

	best, bestVal := int(idxs[0]), vals[0]
	for i := 1; i < cudaArgmaxBlocks; i++ {
		if vals[i] > bestVal || (vals[i] == bestVal && int(idxs[i]) < best) {
			bestVal = vals[i]
			best = int(idxs[i])
		}
	}
	return best
}

// Close frees every device allocation this decoder owns (weights, KV
// cache, embedding, scratch buffers). Safe to call multiple times and
// on a partially-constructed decoder (NewBitNetCUDADecoder calls this
// itself on any construction error).
func (d *BitNetCUDADecoder) Close() {
	if d == nil {
		return
	}
	for i := range d.layers {
		lw := &d.layers[i]
		for _, b := range []*compute.DeviceBuffer{
			lw.tilesQ, lw.tilesK, lw.tilesV, lw.tilesO, lw.tilesGate, lw.tilesUp, lw.tilesDown,
			lw.attnNorm, lw.ffnNorm, lw.attnSubNorm, lw.ffnSubNorm,
		} {
			b.Free()
		}
	}
	for _, b := range []*compute.DeviceBuffer{
		d.finalNorm, d.embedFP16, d.kCache, d.vCache, d.cosTable, d.sinTable,
		d.xBuf, d.residBuf, d.normedBuf, d.normed2Buf, d.qBuf,
		d.attnRawBuf, d.attnOutBuf, d.oOutBuf,
		d.gateBuf, d.upBuf, d.mlpRowBuf, d.downOutBuf,
		d.qxEmbedBuf, d.qxFFNBuf, d.xScaleBuf, d.attnScratch,
		d.logitsBuf, d.argValBuf, d.argIdxBuf,
	} {
		b.Free()
	}
}
