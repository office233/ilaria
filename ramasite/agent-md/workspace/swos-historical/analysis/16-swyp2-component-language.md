# Swyp 2.0 — Component Language Seed

**Date:** 2026-09-28  
**Worktree:** `E:\CEO\wt\repo-separation-swyp2`  
**Status:** implemented seed, tests green

## Purpose

Swyp is being evolved from a scalar verified language into the semantic construction and verification layer between Ilaria and SwypikOS.

The existing Semantic Core, contracts, bounded executor, synthesis, STV2/SWYPB and native emitters remain intact.

The new layer is deliberately declarative. It describes:
- components
- authority/capabilities
- effects
- contracts
- tasks
- agents
- drivers
- models
- experts
- datasets
- training jobs
- verification requirements

Hot-path model kernels, OS internals and drivers remain native Go/C/Rust/CUDA and will be bound through explicit schemas/contracts/FFI rather than rewritten prematurely.

## New compiler subsystem

Added:

```text
swyp/internal/componentspec/spec.go
swyp/internal/componentspec/spec_test.go
swyp/cmd/swyp/component.go
swyp/cmd/swyp/component_test.go
swyp/docs/COMPONENTS.md
swyp/examples/swyp/platform/myriad.swyp
```

Updated:
- `swyp/cmd/swyp/main.go`
- `swyp/README.md`

Swyp version now reports:

```text
Swyp Lang 0.6.0-experimental (components, contracts, Semantic Core, synthesis, STV2)
```

## CLI

Validate:

```powershell
go run ./cmd/swyp component check file.swyp
```

Compile into canonical machine-readable manifest:

```powershell
go run ./cmd/swyp component compile -o manifest.json file.swyp
```

The compiler refuses to overwrite an existing output, preserving the project's existing create-only artifact behavior.

## Supported declaration kinds

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

Supported semantic fields include:
- `capability`
- `effect`
- `state`
- `requires`
- `ensures`
- `invariant`
- `check`
- `forbid`
- `require`
- `verify`
- typed/generic properties

Expert and training relationships are first-class:

```swyp
expert GoConcurrency : IMC1B {
    specialty code.go.concurrency;
}

train GoConcurrency on GoPermissive {
    cohort 512;
    optimizer isx;
    local_steps 128;
}
```

## Validation semantics implemented

The seed validates:

- manifest version
- declaration limits
- field limits
- duplicate symbols
- expert base model existence/type
- training target expert existence
- training dataset existence
- positive cohort
- positive local steps
- required optimizer
- model architecture/weights/storage/compute properties
- expert specialty
- effect must declare capability
- verifier must contain at least one check

Canonical output is deterministic formatted JSON.

## Platform source-of-truth specs now written in Swyp

### Ilaria Myriad

Source:
`ilaria/specs/myriad.swyp`

Defines:
- IMC1B model
- ThalamusRouter expert
- GeneralCortex expert
- curated Myriad dataset
- ISX training declarations
- Hippocampus authority/privacy invariants
- CorticalConnectome invariants
- expert promotion verification

Validation:

```text
Component manifest OK: 9 declarations
```

Generated:
`ilaria/specs/myriad.manifest.json`

SHA256:
`6BC6230F4465290F152FCF60AA84E5803E42CB625C9AD2857CF4188E3023E754`

### SwypikOS Compute Fabric

Source:
`swypik-os/specs/compute-fabric.swyp`

Defines:
- ComputeFabric component
- ExecuteTrainingShard effect
- TrainingWorkerIsolation contract
- TrainCortexShard task
- IlariaTrainingWorker agent
- TrainingCandidate verifier

Validation:

```text
Component manifest OK: 6 declarations
```

Generated:
`swypik-os/specs/compute-fabric.manifest.json`

SHA256:
`B503BB94CA1846FFF020B044E2911A13E660E03D7008B86D52D6C8FA855D8860`

### SwypikOS Control Kernel

Source:
`swypik-os/specs/control-kernel.swyp`

Defines:
- ControlKernel component
- ExecuteEffect
- VerifiedEffect task
- EffectEvidence verifier

Validation:

```text
Component manifest OK: 4 declarations
```

Generated:
`swypik-os/specs/control-kernel.manifest.json`

SHA256:
`2B1B9BF264ABFE3F8878EDBD7C27187CB8ABF054DCF3A1B3C0FE21104617E383`

## Drift protection

All three specs were recompiled into a temporary directory and their SHA256 hashes matched the checked-in canonical manifests exactly.

CI now repeats this as compile + `diff -u`, making the `.swyp` source the source of truth.

## Tests

Targeted:

```text
go test -count=1 ./internal/componentspec ./cmd/swyp
PASS

go run ./cmd/swyp component check examples/swyp/platform/myriad.swyp
Component manifest OK: 7 declarations
```

Full final gate:

```text
gofmt
go vet ./...
go test -count=1 ./...

PASS
8 ok packages, 0 failed
```

## Recommended next Swyp milestone

The component language currently emits validated canonical manifests. The next valuable step is not more syntax.

Implement generated/runtime consumption:

1. generate Go structs/interfaces/manifests from Swyp declarations;
2. make Compute Fabric load/use its generated contract instead of duplicating schema manually;
3. make Control Kernel capability/effect schemas derive from Swyp;
4. define Ilaria Cortical Protocol and Expert Genome in Swyp;
5. add effect-row/type checking and capability propagation;
6. add explicit FFI declarations for Go/Rust/C/CUDA;
7. make drift between generated Go and Swyp source a CI failure.

That would turn Swyp from a specification compiler into the actual semantic spine of the platform.
