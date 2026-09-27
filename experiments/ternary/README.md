# Executable ternary weights

This experiment defines a small, explicit language: a versioned matrix of weights
in {-1, 0, +1}, with fixed semantics `y = W*x`. No model, training, network access,
or self-modifying process is involved. The runtime and matrix dimensions are part
of the program definition; weights alone are not a universal instruction set.

From `D:\swyp lang`:

```powershell
go run ./experiments/ternary/cmd ./examples/swyp/ternary-weights.json
go test ./experiments/ternary/... -count=1
go test ./experiments/ternary -run '^$' -bench . -benchmem -count=3
```

The example contains two rows, `[1,1,-1]` and `[0,-1,1]`. On `[10,4,3]`
they compute `[11,-1]`. Changing the first weight to -1 makes the first output
-9. This is a direct change to executable behavior through weights.

Five weights are packed as base-3 digits into one byte: `weight + 1` maps each
weight to a digit 0..2. Thus complete groups cost 1.6 bits per weight, not exactly
1.58. Partial groups, dimensions, JSON source, slice headers and runtime memory
add overhead. Zero weights omit a contribution, and -1 subtracts an input.

## Verification

Seeded differential tests compare 6,700 input vectors / 46,900 output values
against dense float64 matrix multiplication. Quarter-integer inputs avoid making
an unsupported general floating-point equivalence claim. Tests also cover weight
mutation, incomplete packing groups, invalid dimensions/weights, non-finite
inputs, overflow, and overlapping input/output buffers. Invalid evaluation leaves
the output unchanged. Outputs are finite float64; signed-zero bit identity is not
part of the contract.

## Local measurement

Windows amd64, Intel Core i7-9700, 256 x 256 matrix, deterministic random ternary
weights. Median of three Go benchmark runs; raw output is in
`../../docs/TERNARY_BENCHMARK.txt`.

| Operation | Median time | Allocations/op |
|---|---:|---:|
| Packed ternary evaluation, validated | 488.452 microseconds | 0 |
| Dense float64 evaluation, unchecked | 63.674 microseconds | 0 |
| Validate and pack weights | 264.019 microseconds | 2 |

The packed implementation is about 7.67 times slower in this experiment.
The baseline is deliberately strong: it does not perform the finite-value and
alias-safety checks of the packed evaluator. These timings therefore compare the
listed implementations, not just their number representations. Packing cost is
reported separately and must be added for one-shot use; it can be amortized when
reusing a program. Neither result includes file parsing or process startup.

Weight payload: 13,108 bytes packed versus 524,288 bytes float64, about 40 times
smaller. Against int8 weights (65,536 bytes), the reduction is about 5 times.
This does not mean total application memory shrinks by those factors.

Conclusion: encoding and executing a bounded calculation through ternary weights
works and saves weight storage. This scalar decoder does not demonstrate a speed
improvement, self-programming, general neural inference, or AGI. The next useful
optimization experiment would compare predecoded int8 and vectorized kernels with
equivalent validation, including conversion cost.
