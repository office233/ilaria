# Swyp Components

Swyp's component layer describes architecture and authority. It complements the
existing executable Semantic Core; it does not replace it.

The first implementation supports these top-level declarations:

- `component`
- `capability`
- `effect`
- `contract`
- `task`
- `agent`
- `driver`
- `model`
- `expert`
- `dataset`
- `train`
- `verify`
- `record` — typed protocol/ABI DTOs

Example:

```swyp
model IMC1B {
    architecture "ilaria-microcortex-v1";
    tokenizer "ilarialex-65k";
    weights ternary;
    storage tritpack20;
    compute rgba32;
}

expert GoConcurrency : IMC1B {
    specialty code.go.concurrency;
    benchmark "go-race-v1";
}

dataset GoPermissive {
    require provenance;
    require commercial_compatible;
    forbid secrets;
}

train GoConcurrency on GoPermissive {
    cohort 512;
    optimizer isx;
    local_steps 128;
}
```

Validate it:

```powershell
go run ./cmd/swyp component check examples/swyp/platform/myriad.swyp
```

Compile it to the canonical, machine-readable manifest consumed by platform
components:

```powershell
go run ./cmd/swyp component compile -o myriad.json examples/swyp/platform/myriad.swyp
```

Generate Go DTOs from `record` declarations:

```powershell
go run ./cmd/swyp component go -package myriad -o types_gen.go records.swyp
```

Supported record field types in the first codegen version are `string`,
`bool`, `i64`, `u64`, `bytes`, `string_list` and `string_map`.

This is deliberately a declarative layer. Hot-path code remains Go/Rust/C/CUDA
and is connected through explicit capabilities, contracts and future FFI
declarations rather than being rewritten prematurely.

The repository already uses this layer for:

- `../ilaria/specs/myriad.swyp`
- `../swypik-os/specs/compute-fabric.swyp`
- `../swypik-os/specs/control-kernel.swyp`

Their checked-in `*.manifest.json` files are generated from Swyp source, and CI
recompiles them into a temporary directory and diffs the canonical output. The
`.swyp` source is the source of truth.
