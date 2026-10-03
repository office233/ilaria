# TritPack20 runtime

`tritpack20` is the native, model-independent reference codec and CPU matrix-
vector kernel for packed ternary IMC projection snapshots.

It implements only the storage and projection primitive. It does **not** load
real model weights, run a transformer, perform complete inference, provide OS
authority, implement device kernels, or provide distributed/P2P behavior.

## API

```go
limits := tritpack20.Limits{
    MaxInputDim:      4096,
    MaxOutputDim:     16384,
    MaxTrits:         1 << 28,
    MaxPayloadBytes:  64 << 20,
    MaxSnapshotBytes: (64 << 20) + 88,
}

snapshot, err := tritpack20.NewSnapshot(
    in,
    out,
    weightScale,
    ternaryWeights, // flattened [in,out], values only -1/0/+1
    limits,
)

dst := make([]float32, snapshot.Out())
err = snapshot.MatVec(dst, int8Activations, activationDequantScale)
```

All limits are explicit. There is no package-global model or storage policy.

## Packing

Each little-endian `uint32` contains 20 base-3 digits:

| Trit | Digit |
| ---: | ---: |
| -1 | 0 |
| 0 | 1 |
| +1 | 2 |

The first trit is the least-significant base-3 digit. The exact payload size is
`4 * ceil(N/20)` bytes. A full word must be smaller than `3^20`.
Unused high digits in the final partial word must be zero; alternate padding is
rejected as non-canonical.

Example golden vectors:

```text
[-1]                              -> 00 00 00 00
[ 0]                              -> 01 00 00 00
[+1]                              -> 02 00 00 00
20 x +1                           -> 90 1b d4 cf
20 x +1 followed by one 0         -> 90 1b d4 cf 01 00 00 00
```

`Pack`, `Unpack`, and `ValidatePacked` are allocation-free when caller
buffers are already allocated.

## Projection semantics

The canonical IMC source computes projections as `x @ w`, where weight
matrices are created as `[in,out]`. TritPack20 preserves that row-major
flattening:

```text
flat_weight_index = input_index * out + output_index
```

The existing IMC ternary path uses one abs-mean scale for each projection
tensor and per-token symmetric int8 activation quantization. Accordingly:

- the immutable snapshot stores one positive finite FP32 `weightScale`;
- `MatVec` receives int8 activation integers and one positive finite
  `activationScale`, interpreted as the dequantization step;
- the integer dot product is accumulated in `int64`;
- output is `float32(accumulator) * activationScale * weightScale`.

The snapshot shape validation bounds `in` so the worst-case sum with an int8
value of -128 cannot overflow `int64`.

`MatVec` writes directly to caller-owned output, decodes individual trits from
packed words, allocates no memory on a valid call, and never expands the matrix.

## Snapshot format

See [TRITPACK20_V1.md](../../../ramasite/docs/ilaria/architecture/TRITPACK20_V1.md) for the fixed
v1 binary header, hash and validation contract.

Snapshots copy their input exactly once into package-owned canonical storage.
`MarshalBinary` returns a copy, so callers cannot mutate a live snapshot.

## Validation

The package rejects:

- invalid trits, words, padding, lengths and endian-incompatible bytes;
- zero/oversized dimensions and `in*out` overflow;
- configured trit/payload/snapshot limit violations before snapshot allocation;
- unknown version/layout, non-zero reserved fields, truncation and hash mismatch;
- non-finite or non-positive weight/activation scales;
- wrong activation/output slice lengths.

Tests use synthetic ternary matrices only and require no model checkpoint.
