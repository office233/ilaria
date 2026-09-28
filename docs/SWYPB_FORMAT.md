# SWYPB version 1: persistent Swyp modules

SWYPB is a self-describing container for the existing STV2 backend. It is not a
new source language, a native executable, or an AI model. Source remains `.swyp`.
The `swyp` executable loads and runs `.swypb`; a Go toolchain and the original
source are not needed at execution time. Building `swyp` from its implementation
sources still requires Go.

## Commands

```sh
swyp compile --target stv2 -o sum.swypb examples/swyp/sum.stv2.swyp
swyp exec sum.swypb 100
swyp exec -steps 2000 sum.swypb 100
```

Options precede the filename. `stv2` is the default and only target. Compile
requires a NEW output path, parses/checks/lowers source, and writes a module
without running guest code. It accepts no input argument values. Exec needs no
`.swyp` file, accepts exactly the declared number of decimal integer arguments,
and returns JSON. It never recompiles, fetches dependencies or calls a model.
The module cannot override the host's fuel: the limit is 1..1,000,000 STV2 steps.

Existing `run`, `build`, `web`, `synth` and `ternary` commands remain unchanged.
`swyp-stv2 -o file.stv2` and `STV2Module.Bytecode()` still export RAW STV2 for
compatibility; raw files are not accepted by `swyp exec`.

To build the tool once on the feature branch:

```sh
go build -o swyp ./cmd/swyp
```

On Windows use `go build -o swyp.exe ./cmd/swyp`, then `./swyp.exe` in PowerShell.
No release package or installation into PATH is created by these commands.

## Wire format

All multibyte integers in the header are little-endian. Header size: 16 bytes.

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII `SWYB` |
| 4 | 2 | Container version, exactly 1 |
| 6 | 1 | Target ID, 1 = STV2 |
| 7 | 1 | Execution profile, 1 = safe-integer (`RunV2Exact`) |
| 8 | 1 | Result kind, 1 = number, 2 = boolean |
| 9 | 1 | Input argument count, 0..4 |
| 10 | 2 | Reserved, both zero |
| 12 | 4 | Length of STV2 payload in bytes |
| 16 | variable | Canonical STV2 payload, INCLUDING its 8-byte header |
| after payload | 32 | SHA-256 of the 16-byte header plus payload |

Version 1 has one entry point (instruction zero). Arguments are safe integers
placed in r0..r3 according to the declared count; remaining registers start at
zero. The profile fixes numeric input semantics; there is no user-defined type
table or source/debug metadata. Result `number` is an integer in the safe domain.
A boolean result must be exactly 0 or 1; any other returned integer is an error,
not implicitly coerced to false/true.

A maximum 64 KiB read/allocation bound applies to the complete module. STV2's
4,096-instruction limit is stricter: its largest payload is 22,946 bytes and the
corresponding module is 22,994 bytes. The module overhead is exactly 48 bytes.
With read-only operand reuse, the sum example is 98 bytes of STV2 plus 48 bytes,
or 146 bytes in total (16 instructions). Earlier compilers emitted 157-byte,
18-instruction modules for the same example; those modules remain valid. The
wire format and VM instruction semantics have not changed. Optimized code can
consume less instruction fuel for the same source computation.
These sizes exclude the executable, decoded instructions and runtime memory.
See [the research campaign](AI_LANGUAGE_RESEARCH_20260928.md) for measured
variants, source hashes, limitations and cross-language comparisons.

Unknown versions, targets, profiles and type tags, nonzero reserved fields,
incorrect lengths, checksum mismatches and malformed STV2 are rejected. The
loader never falls back to another target/profile or ignores trailing bytes.
The public checksum detects accidental corruption. It is NOT a digital
signature, author authentication or a security certification. Anyone can
recompute it after editing a module; semantic/runtime checks are still needed.

## API and ownership

`(*STV2Module).MarshalBinary() ([]byte, error)` serializes a complete module.
`LoadSWYPB([]byte) (*STV2Module, error)` loads it without execution. Returned
modules own their decoded program and byte slice. Caller mutations of input,
`Bytecode()` results or serialization results cannot modify the module. Runs use
fresh register state and can run concurrently on one immutable module.

Validation is structural. Loading a module does NOT prove that it came from a
type-checked Swyp source, that all execution paths return, or that it terminates.
The STV2 instruction semantics remain those of the VM, including integer DIV
for hand-authored bytecode. The source compiler still rejects `/` rather than
silently replacing Swyp float division. The exact profile traps any initial or
intermediate value outside +/-(2^53-1); the bool result contract is checked on
successful halt. No guest filesystem/network/host-call instructions are added.

Compile refuses existing files and symlinks via exclusive creation. On normal
write/close errors the new partial file is removed. Crash-atomic publication is
not promised; incomplete output is rejected on load. A failure to print the
success status after a completed write is reported but does not delete a valid
module. Reading is size-bounded, not a timeout guarantee for special devices.

## Validation

Tests cover number/bool and arities 0..4, an independent fixed wire-format
vector, all truncations of a sample, bit flips, all 4,096 single-header-byte
variants with recomputed checksums, inner-format violations, numeric/fuel/result
contracts, maximum instruction count, ownership and concurrent reads/writers.
A seeded corpus checks 1,000 generated programs / 5,000 runs against the existing
Swyp AST interpreter after serialization and reloading. CLI tests compile and
execute in fresh processes with deleted source and a PATH without toolchains.
The CI workflow also builds and invokes the actual full `swyp` command this way.

```sh
go test -v -count=1 -run '^TestSWYPB' ./internal/swyplang ./cmd/swyp
go test ./internal/swyplang -run '^$' -fuzz '^FuzzSWYPBLoad$' -fuzztime=15s -parallel=2
go test -race -count=1 ./internal/swyplang ./cmd/swyp
go vet ./...
```

Fuzzing exercises both raw input and a copy with the public checksum recomputed,
so the digest does not prevent fuzz coverage of the inner decoder. Bounded tests
and fuzz runs are not proof of absence of defects. Source support still has the
same eight-register, single-main safe-integer restrictions. This milestone does
not implement spilling, functions, strings, UI integration or native codegen.
