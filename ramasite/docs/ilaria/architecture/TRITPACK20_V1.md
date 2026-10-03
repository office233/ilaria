# TritPack20 v1

Status: native IMC runtime format v1.

Scope: deterministic packed storage for one ternary IMC projection matrix and a
minimal CPU reference MatVec. This document does not define an IMC checkpoint,
transformer runtime, device-specific optimized kernel, complete inference,
training format, universal hardware support, or P2P behavior.

## 1. Canonical IMC relationship

`specs/myriad.swyp` declares:

```text
weights ternary;
storage tritpack20;
```

The canonical IMC implementation performs a projection as `x @ w`. Projection
parameters are allocated with shape `[in,out]`; the ternary path applies an
abs-mean scale to the projection tensor and symmetric int8 activation
quantization per token.

TritPack20 therefore stores one matrix in row-major `[in,out]` order, one
positive finite FP32 weight scale, and accepts an explicit positive finite int8
activation dequantization scale at execution time.

## 2. Trit word codec

One word is an unsigned 32-bit little-endian integer containing exactly 20
base-3 digit positions.

```text
trit -1 -> digit 0
trit  0 -> digit 1
trit +1 -> digit 2
```

For trits `t[0..k)`, `k <= 20`:

```text
word = sum((t[i] + 1) * 3^i)
```

Trit 0 is therefore the least-significant base-3 digit.

`3^20 = 3,486,784,401`, which fits in the unsigned 32-bit word domain. A full
20-trit word is canonical only when:

```text
0 <= word < 3^20
```

For a final partial word containing `k < 20` real trits, every unused high
digit is canonical zero padding. Equivalently:

```text
0 <= final_word < 3^k
```

The padding digit is a storage sentinel and does not represent an additional
logical -1 trit because the logical trit count is carried separately.

For `N` logical trits:

```text
word_count    = ceil(N / 20)
payload_bytes = 4 * word_count
```

No shorter, longer or variable-width payload is valid.

### Golden byte vectors

```text
trits                                          little-endian payload
[-1]                                           00 00 00 00
[ 0]                                           01 00 00 00
[+1]                                           02 00 00 00
[-1,0,+1,-1,0,+1,-1,0,+1,-1,
  0,+1,-1,0,+1,-1,0,+1,-1,0]                  1f 6e ed 57
20 x +1                                        90 1b d4 cf
20 x +1, then one 0                            90 1b d4 cf 01 00 00 00
```

## 3. Snapshot v1 binary layout

All integer fields are little-endian. The fixed header is 88 bytes.

| Offset | Size | Field | v1 rule |
| ---: | ---: | --- | --- |
| 0 | 8 | magic | ASCII `TRITPK20` |
| 8 | 2 | version | `1` |
| 10 | 2 | header_bytes | `88` |
| 12 | 1 | layout | `1` = row-major `[in,out]` |
| 13 | 3 | reserved | all zero |
| 16 | 8 | input_dim | positive |
| 24 | 8 | output_dim | positive |
| 32 | 8 | trit_count | exactly `input_dim * output_dim` |
| 40 | 8 | payload_bytes | exactly `4 * ceil(trit_count/20)` |
| 48 | 4 | weight_scale | IEEE-754 FP32 bits; finite and > 0 |
| 52 | 4 | reserved | all zero |
| 56 | 32 | sha256 | snapshot digest below |
| 88 | payload_bytes | payload | canonical TritPack20 words |

There is no trailing data.

The SHA-256 input is:

```text
ASCII/bytes "ilaria.tritpack20.snapshot.v1\0"
|| header bytes [0,56)
|| packed payload bytes [88,end)
```

The stored hash field itself is excluded from its digest. This covers version,
layout, dimensions, declared trit/payload sizes, exact weight-scale bits,
reserved header state and every packed weight byte.

SHA-256 here is a deterministic integrity/content check, not authentication or
checkpoint provenance. A higher-level checkpoint/runtime contract must supply
any required signature, lineage or trust decision.

The v1 golden snapshot for a `[1,1]` matrix containing trit `+1` with
`weight_scale = 0.5f` is:

```text
54524954504b32300100580001000000
01000000000000000100000000000000
01000000000000000400000000000000
0000003f00000000
bb396953238f98f82dc0688c6a64c92b
89b65c8f538d315624d288155ed22b63
02000000
```

Line breaks are presentation only.

## 4. Required parser validation order

A host supplies explicit `Limits`:

```text
MaxInputDim
MaxOutputDim
MaxTrits
MaxPayloadBytes
MaxSnapshotBytes
```

The parser:

1. validates the limits themselves;
2. rejects an input byte slice larger than `MaxSnapshotBytes`;
3. validates fixed header availability, magic/version/header size/layout and
   zero reserved bytes;
4. validates non-zero dimensions, configured dimension bounds, safe int64
   accumulation bound, integer/address-space bounds and overflow-safe
   `input_dim * output_dim`;
5. derives the only valid trit count, packed byte length and total snapshot
   length, then compares every declared field and configured limit;
6. validates the FP32 weight scale;
7. validates every packed word and final padding without allocation;
8. recomputes and compares SHA-256;
9. only then allocates and copies the canonical immutable snapshot.

The parser never trusts path names, file metadata, model checkpoints or ambient
OS state because none of those are inputs to this package.

## 5. Immutability and memory bound

A live `Snapshot` owns one encoded byte buffer:

```text
88-byte header + exact packed payload
```

It does not store an expanded ternary matrix. Constructor input trits and parser
input bytes are not retained. Public binary export returns a copy.

The MatVec hot path uses:

- the immutable encoded payload;
- caller-owned int8 input;
- caller-owned FP32 output;
- one local `int64` accumulator plus scalar loop state.

It allocates no heap memory on a valid call and has no scratch array
proportional to either matrix dimension.

## 6. CPU reference MatVec

For `W[in,out]`, int8 activation vector `q[in]`, activation dequantization
scale `sa`, and snapshot weight scale `sw`:

```text
integer_sum[o] = sum_i(int64(q[i]) * int64(W[i,o]))
dst[o]         = float32(integer_sum[o]) * sa * sw
```

The validation contract restricts `in <= MaxInt64 / 128`, so the worst-case
integer accumulation cannot overflow for any int8 activation and ternary
weight.

Both scales must be finite and strictly positive. Their FP32 product must also
remain finite.

The reference implementation decodes each needed base-3 digit directly from
the packed word. It intentionally prioritizes a small, auditable memory
footprint and deterministic semantics over SIMD/GPU throughput.

Tests compare against an independent scalar implementation using the original
unpacked trit fixture. The accepted FP32 comparison tolerance is:

```text
abs(got - want) <= 2e-6 * max(1, abs(want))
```

This permits normal FP32 evaluation-order rounding while requiring exact
integer accumulation semantics.

## 7. Non-claims

Passing this codec/kernel test suite proves the TritPack20 v1 storage and scalar
projection contracts on synthetic fixtures. It does not establish:

- end-to-end IMC inference;
- production checkpoint conversion;
- quality equivalence of a deployed quantized model;
- optimized CPU/GPU/NPU performance;
- universal device compatibility;
- a sub-1GB full resident IMC-1B deployment;
- distributed or P2P training/inference.

Those require separate integration and hardware/model evidence.
