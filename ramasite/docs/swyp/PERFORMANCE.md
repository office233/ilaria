# Swyp performance architecture

Swyp has two distinct performance paths:

1. **Legacy scalar native** — the original checked language lowered directly to C.
2. **Semantic Core AOT** — typed `i64`, strict finite-`f64` and explicit
   hardware-IEEE `ieee64` Core IR validated first, then lowered to native C11.

For performance-sensitive verified code, Semantic Core AOT is the preferred direction.

## Runtime validation status (2026-10-02)

The native runtime parity corpus (`cmd/swyp/native_runtime_parity_test.go`)
executes identical programs and expectations on Windows x86-64 PE, Linux x86-64
static ELF/PIE and Linux AArch64 static ELF/PIE under `qemu-aarch64`
(`SWYP_QEMU_AARCH64`). Statements below that describe Linux or AArch64 paths as
only "structurally validated" or "pending QEMU" are superseded for everything
that corpus covers: argv parsing, process IO, clock, rng, `fs.read`/`fs.write`,
`net.connect`, `net.fetch`, storage/vec ABIs, native calls, checked arithmetic
including `div`/`rem`, spills and IEEE64 arithmetic. AArch64 evidence is
user-mode emulation, not physical hardware; no AArch64 performance numbers are
claimed.

## Native profiles

### safe

- exact Core fuel accounting at function, instruction and terminator boundaries;
- checked `i64` overflow;
- finite `f64`;
- division/remainder checks;
- pure-only native AOT;
- GCC `-O2`.

### fast

- checked `i64` overflow remains;
- finite `f64` remains;
- division/remainder checks remain;
- fuel remains bounded, but only loop backedges and recursive call cycles are charged;
- non-recursive calls do not pay fuel ticks;
- GCC `-O3`;
- optional `-cpu native` adds `-march=native -mtune=native`;
- optional `-lto` enables GCC link-time optimization;
- optional `-strip` removes symbols from the final executable.

`fast` therefore changes fuel accounting, not successful value semantics.

The same split now exists in the embedded Core executor: `Run` / `core-run -profile safe` keep exact per-instruction fuel, while `RunFast` / `core-run -profile fast` tick at function entry and loop backedges. Verification always uses the exact `Run` path.

`RunTurbo` / `core-run -profile turbo` keeps the same coarse fast-profile
fuel policy but stores scalar frame slots as raw 64-bit words instead of boxed
`Value` structs. It is an execution optimization only; verification remains on
the exact `Run` path.

## Reproducible benchmark

Run:

```powershell
python benchmarks/swyp/core_aot_bench.py \
  --output E:\temp\swyp-core-bench \
  --repetitions 9
```

The retained 2026-09-29 workstation report is:

`benchmarks/results/SWYP_CORE_AOT_20260929.json`

Hardware / toolchain facts are recorded in that JSON.

### Observed medians

| Workload | Swyp Core safe | Swyp Core fast | C -O3 |
|---|---:|---:|---:|
| i64 prime count, 300000 | 138.99 ms | **105.65 ms** | 92.73 ms |
| finite-f64 Mandelbrot, 640 | 71.97 ms | **52.80 ms** | 21.37 ms |

The same Mandelbrot source with explicit `ieee64` measured **24.15 ms** in
the fast profile versus **21.37 ms** for C -O3 on this run (about 1.13x C wall
time). The workload result was identical: `4449924`.

All compared executables returned identical workload results.

Interpretation:

- On this i64 workload, Core fast is about **1.14x C's wall time** while retaining checked integer overflow and bounded execution.
- Strict finite-f64 remains substantially more expensive because Swyp rejects non-finite intermediate arithmetic while the C reference does not.
- `ieee64` removes that strict-finite semantic cost explicitly rather than via
  hidden fast-math and, on this workload, runs close to the matched C baseline.
- These are workload results on one non-isolated workstation, not a language-wide ranking.

## Embedded Core runtime — 2026-09-29

The Core executor hot path was profiled directly on the current i7-9700 workstation. The initial implementation allocated a temporary type slice inside every `Apply` and a temporary operand slice for every non-trivial instruction. A 64-add prepared Core function measured roughly 17–18 µs/run, 62,624 B/run and 130 allocations/run.

After allocation-free operand typing, direct unary/binary dispatch and a 128-slot stack frame cache, the retained command is:

```powershell
go test -run=^$ -bench='Benchmark(ApplyI64Add|CoreRunAddChain64|CoreRunFastAddChain64)$' -benchmem -benchtime=3s -count=1 ./internal/coreir
```

Measured result:

| Path | Time | Heap bytes | Allocations |
|---|---:|---:|---:|
| `Apply(i64 add)` | ~20.6 ns/op | 0 B | 0 |
| Core `Run` 64-add chain | ~2.09 µs/op | 0 B | 0 |
| Core `RunFast` 64-add chain | ~1.71 µs/op | 0 B | 0 |

`Prepare` was also removed from the JSON serialization hot path. On the same 64-operation fixture it changed from roughly **561 µs / 142 KB / 5,416 allocations** to roughly **11–12 µs / 16.7 KB / 146 allocations** while retaining snapshot ownership. The optimized Core pass measured roughly **19 µs** on the same fixture after switching its internal copy to a structural clone.

This is a microbenchmark on one non-isolated workstation, not a language-wide speed claim. It does demonstrate that prepared embedded Core execution no longer needs per-operation heap allocation on the common small-frame path. Performance tests live in `internal/coreir/performance_test.go`; changes to the executor should preserve the zero-allocation property for the covered small-frame workload.

## Native/LTO experiment

`core-build` also accepts `-cpu native -lto -strip`. The 2026-09-29 A/B run showed mixed results: native/LTO helped strict `f64` in one run but was neutral/slightly worse for the i64 workload and for `ieee64`. It therefore remains explicit opt-in rather than a default. The compiler should select such flags from measured target/workload properties, not from a blanket "more optimization flags is faster" assumption.

## Current optimization strategy

Do not use unsafe compiler flags to manufacture benchmark wins.

Next compiler milestones:

1. Core optimization pass (initial constant folding, CFG simplification and
   dead-value elimination are implemented; continue with global propagation):
   - constant propagation/folding;
   - CFG simplification;
   - dead code/value elimination;
   - copy propagation.
2. SSA form and liveness.
3. Swyp-owned register allocation and a direct x86-64/ARM64 backend so release builds do not require GCC.
4. Range/refinement analysis so proven-safe integer/float checks can be removed without weakening semantics.
5. Core IR -> compact typed bytecode for instant embedded execution and cached modules.
6. Extend explicit numeric policies (`ieee64` exists) to vector/tensor kernels.
7. Tensor/array IR with CPU SIMD and GPU/NPU backends.
8. Device-specialized AOT selected by SwypikOS hardware manifests.
9. Profile-guided optimization and code layout only after reproducible benchmarks show a gain.

The performance rule remains: **correctness first, then compare correct variants**.

## Direct x86-64 backend — phase 1

`swyp core-x64` now emits GAS Intel-syntax x86-64 assembly directly from the
optimized SSA view. The assembly path has a CFG-aware backend:

- multiple reachable blocks;
- conditional branches and jumps;
- SSA phi nodes lowered on predecessor edges;
- GPR stack spills through an rbp-relative frame;
- acyclic pure scalar native calls for i64/u64/bool;
- no FP native calls or FP spills yet;
- i64/u64/bool;
- const/move/neg/not;
- add/sub/mul and u64 bitwise ops;
- integer/bool comparisons;
- checked i64 overflow through a backend status code.

```powershell
swyp core-x64 -entry add -o add.s add.swyp
swyp core-x64-build -entry add -o add.exe add.swyp
swyp core-x64-pack -entry add -o add.swx64 add.swyp
```

The CFG assembly ABI is `swyp-x64-cfg-win64-v1`. Integer/bool values use
the GPR bank; explicit `ieee64` uses XMM6–XMM15 with normal Win64 XMM
argument/return registers and callee-save preservation. IEEE comparisons handle
unordered/NaN cases explicitly. `f64` strict remains intentionally unsupported
in the direct backend until finite/div-zero checks are implemented; it stays on
Core/C AOT. Unsupported features fail explicitly rather than silently falling
back. The next backend milestones are call elimination/lowering, FP spills and
SIMD/vector lowering.

### Native scalar calls

The x86-64 CFG backend now emits acyclic pure scalar calls that remain after
bounded inlining:

- internal calls target the generated `*_raw` function directly;
- up to 4 `i64/u64/bool` arguments use the Win64 GPR argument bank;
- `RAX` returns the value and `RDX` returns backend status;
- caller live values remain in callee-saved registers or spill slots;
- recursive call cycles fail closed;
- floating-point native calls remain unsupported rather than silently changing
  ABI semantics.

Using the raw ABI avoids a second public-wrapper call and avoids allocating a
temporary status object for each internal call.

`core-x64-build` uses GCC only as assembler/linker for the Swyp-generated
function plus a tiny CLI harness; GCC does not optimize the Swyp function body.

`core-x64-pack` removes the external toolchain completely. It preserves the
leaf-v1 machine-code ABI for simple leaf functions and uses
`swyp-x64-cfg-machine-win64-v1` for single-function GPR CFGs with branches,
loops/backedges, SSA phi edge copies and GPR spills. Closed acyclic scalar call
graphs use `swyp-x64-cfg-machine-win64-v2`: the entry remains at offset zero,
internal calls use patched `rel32` targets, Win64 shadow-space/alignment is
preserved, caller live values survive in callee-saved registers/spills, and
backend status propagates through nested calls. Call-free explicit `ieee64`
CFGs use `swyp-x64-cfg-machine-fp-win64-v1`, with direct SSE2 arithmetic,
ordered/NaN-aware comparisons, FP spill slots, positional XMM arguments/results
and preservation of Win64 nonvolatile XMM6-XMM15. Closed call graphs that mix
GPR scalars and `ieee64` use `swyp-x64-cfg-machine-fp-calls-win64-v1`: each of
the first four program arguments follows its Win64 positional GPR/XMM lane,
FP/GPR return values use XMM0/RAX respectively, the appended status pointer keeps
its positional ABI slot, and integer trap status propagates through FP-returning
calls. Strict finite `f64` remains fail-closed rather than silently changing
semantics.

The `.swx64` artifact contains the ABI, typed signature, machine-code SHA-256
and generated code bytes. Swyp itself does not expose a generic arbitrary-code
loader; SwypikOS can later admit signed modules through its capability/security
boundary.

`core-x64-object` emits deterministic native relocatable objects directly from
the same packed machine-code backend:

```powershell
swyp core-x64-object -format coff  -entry fn -o fn.obj program.swyp
swyp core-x64-object -format elf   -entry fn -o fn.o   program.swyp
swyp core-x64-object -format macho -entry fn -o fn.o   program.swyp
```

- `coff` targets Windows AMD64 directly and exports `swyp_core_<entry>` over the
  existing Win64 packed ABI;
- `elf` emits ELF64/x86-64 `ET_REL` and prepends a System V AMD64 entry thunk;
- `macho` emits Darwin x86-64 `MH_OBJECT`, also through the System V entry
  thunk, exporting `_swyp_core_<entry>` as required by Darwin symbol naming.

The SysV thunk stages program arguments plus the trailing status pointer in a
40-byte Win64 call area, remaps independent SysV GPR/XMM argument banks into
Swyp's positional Win64 lanes, then calls the unchanged packed blob. Internal
Swyp calls therefore keep their existing verified ABI and relocations. ELF,
COFF and Mach-O objects are parsed back in tests with `debug/elf`, `debug/pe`
and `debug/macho`; Windows COFF objects are additionally linked with GCC and
executed end-to-end, including mixed `bool`/`ieee64` native calls.

`core-x64-dll` goes one step further and emits a complete **PE32+ AMD64 DLL**
directly, without invoking an assembler or linker:

```powershell
swyp core-x64-dll -entry fn -o fn.dll program.swyp
```

The image contains deterministic `.text`, `.edata` and `.reloc` sections, no
imports, no `DllMain`, and exports `swyp_core_<entry>` directly over the Win64 packed ABI.
The emitted DLL is parsed with `debug/pe`, loaded with `LoadLibrary`, resolved
with `GetProcAddress` and executed in tests for both integer and mixed
`bool`/`ieee64` call graphs. A real `IMAGE_REL_BASED_DIR64` relocation keeps
`DYNAMIC_BASE`, `HIGH_ENTROPY_VA` and `NX_COMPAT` truthful. Tests load two
identical DLL copies simultaneously at distinct image bases and execute both,
forcing the Windows loader to exercise rebasing rather than merely parsing the
relocation metadata.

`core-x64-exe` emits standalone **PE32+ AMD64** or **ELF64/x86-64** executables
directly, again without invoking an assembler or linker. The direct process ABI
now accepts up to four `i64/u64/bool/ieee64` command-line parameters:

```powershell
swyp core-x64-exe -format pe  -entry answer -o answer.exe program.swyp
swyp core-x64-exe -format elf -entry answer -o answer     program.swyp
swyp core-x64-exe -format elf -pie -entry answer -o answer-pie program.swyp
```

The entry returns `i64`, `u64` or `bool`; that value becomes the process exit
code. Argument parsing is generated machine code rather than a CRT dependency:

- `i64`: optional sign with full `INT64_MIN..INT64_MAX` range and overflow
  rejection;
- `u64`: full `0..UINT64_MAX` range with checked decimal accumulation;
- `bool`: `0`, `1`, `false`, `true`;
- `ieee64`: signed decimal/fractional syntax plus `e/E` exponent, evaluated
  directly through SSE2; large exponents naturally converge to IEEE infinity or
  zero. Malformed input or an incorrect argument count exits with code `2`.

- `-format pe` contains `.text`, `.idata` and `.reloc`, imports only
  `KERNEL32!ExitProcess` plus `GetCommandLineA` when parameters are present,
  calls both through RIP-relative IAT slots, and preserves ASLR/NX metadata.
  Runtime tests execute generated Windows EXEs directly and cover signed/unsigned
  boundaries, booleans, fractions/exponents, quoted executable paths and invalid
  argument handling.
- `-format elf` emits a static `ET_EXEC` with one RX `PT_LOAD`, no `PT_INTERP`,
  no libc and no imported libraries. `_start` reads `argc/argv` directly from the
  process-entry stack, reuses the same generated scalar parser, stages Win64
  positional lanes for the packed backend and terminates through Linux syscall
  `exit(60)`.
- `-format elf -pie` emits the same runtime as a zero-based static `ET_DYN`
  image. The load segment has virtual address 0 and entry/symbol addresses are
  relative offsets; all generated calls/branches remain PC-relative, so the
  image itself needs no dynamic relocation table. This is structurally validated
  as a static PIE; Linux runtime ASLR execution still requires a Linux host or
  emulator, which is not installed on this workstation.

Standalone process effects remain capability-gated. `tcp_connect(host, port)`
now lowers to `net.connect -> bool` and requires an explicit
`network_connect` capability (`-allow-net-connect` in the direct executable
commands). The current contract is intentionally narrow: `host` must be an
IPv4 dotted-decimal literal and `port` must be in `1..65535`; there is no hidden
DNS resolution or HTTP layer. Windows x86-64 uses Winsock and is runtime-tested
against an ephemeral **loopback-only** listener; a refused connection returns
`false`, while malformed endpoints fail closed through backend status. Linux
x86-64 uses direct `socket(41)`, `connect(42)` and `close(3)` syscalls. Linux
AArch64 uses direct `socket(198)`, `connect(203)` and `close(57)` syscalls and is
validated structurally/cross-compiled pending ARM64 runtime hardware/emulation.

The immutable module byte arena now also supports checked native `bytes.get` on
x86-64 and AArch64. `fs.read` uses a separate bounded mutable arena on both
standalone backends: x86-64 is runtime-tested, while Linux AArch64 is structurally
validated with direct `openat(56)`, `lseek(62)`, `read(63)` and `close(57)`
syscalls pending real ARM64 execution. AArch64 `bytes.get` distinguishes immutable
module descriptors from runtime descriptors and only exposes the committed arena
prefix.

The System V adapter used by ELF/Mach-O object emission is also executed in the
Windows test suite using GCC's `sysv_abi` attribute. Mixed `bool`/`ieee64` calls
and the four-GPR-argument/status-pointer case both execute correctly, rather
than being validated only by container parsing.

### Native process IO effects

Standalone process backends now admit an intentionally narrow, capability-gated
host-effect surface while reusable packed/object/DLL artifacts remain pure-only:

- `print(x)` lowers to Core `io.stdout`, effect `io.stdout`, capability
  `stdout_write`;
- `eprint(x)` lowers to Core `io.stderr`, effect `io.stderr`, capability
  `stderr_write`;
- effect/capability metadata propagates transitively through the Core call graph;
- the normal Core executor still refuses to execute host effects and returns
  `effectful_program`; only the standalone process compiler grants these two
  capabilities;
- `core-x64-pack`, object emission and DLL emission continue to reject the same
  effectful source as non-pure.

The native text formatter supports `i64`, `u64`, `bool` and exact `ieee64` plus newline.
Windows process images synthesize `GetStdHandle` + `WriteFile` calls through the
IAT; Linux x86-64 and AArch64 helpers use direct `write` syscalls. Native helper
calls preserve live backend register allocations and propagate write failure as
backend status `2` (`1` remains arithmetic overflow/trap). Windows runtime tests
capture stdout/stderr independently and verify exact `42\n`, `true\n` and
`false\n` output, including effects reached through helper functions.

`clock()` is now a first-class Core process effect. It lowers to
`clock.read -> u64`, declares effect `clock.read` plus symbolic capability
`clock_read`, and remains rejected by reusable pure packed/object paths. Direct
process images return monotonic nanoseconds without a CRT: Windows uses
`GetTickCount64 * 1_000_000`, Linux x86-64 uses
`clock_gettime(CLOCK_MONOTONIC)` syscall 228, and Linux AArch64 uses syscall
113. Windows runtime tests verify a nonzero printed clock value and monotonic
`b >= a`; AArch64 emitter tests verify clock and stdout syscalls in the image.

`random()` is the corresponding native entropy effect. It lowers to
`rng.sample -> u64`, declares effect `rng.sample` plus symbolic capability
`rng_sample`, and is available only to standalone process images; reusable
`.swx64`/`.swa64` packed modules remain pure and reject it. Windows x86-64 uses
`BCryptGenRandom(NULL, ..., BCRYPT_USE_SYSTEM_PREFERRED_RNG)` from `BCRYPT.dll`
rather than a clock-derived PRNG; Linux x86-64 uses direct `getrandom` syscall
318 and Linux AArch64 uses syscall 278. OS/runtime failure propagates through
the backend status channel instead of returning fabricated entropy. Windows
runtime tests execute `print(random())`, parse the resulting full-width `u64`,
and verify the PE imports `BCryptGenRandom:BCRYPT.dll`; ARM64 emitter tests
verify `getrandom` plus stdout syscall lowering. The legacy C backend rejects
`random()` explicitly and directs callers to the Core standalone process path.

`write_file(path, data)` is the first native filesystem effect. It lowers to
Core `fs.write(bytes,bytes)`, declares effect `fs.write` plus symbolic capability
`workspace_write`, and standalone executable generation requires an explicit
`-allow-fs-write` grant. Without that flag, x86-64 and AArch64 process builds
fail closed before image emission. Reusable pack/object/DLL paths remain
pure-only.

Filesystem data stays in Core's opaque `Bytes` ABI (`offset:u32 + length:u32`):
the module-owned immutable byte arena is emitted into a dedicated read-only,
non-executable `.rodata` region and resolved only inside the backend helper after bounds checks. Paths
are copied into a bounded 240-byte local buffer and NUL-terminated; guest code
never receives a raw host pointer. Windows x86-64 uses
`CreateFileA`/`WriteFile`/`CloseHandle` and is runtime-tested by creating and
verifying a real file. Linux x86-64 uses direct `openat`/`write`/`close` syscalls;
Linux AArch64 uses syscalls 56/64/57 and an `ADR` PC-relative reference to the
arena, which also works in static PIE images. Linux helpers remain import-free.

Direct native `bytes.len` now works on both x86-64 and AArch64 because it only
decodes the descriptor's low 32-bit length field. Windows process images use a
PE `.rdata` section without write/execute permission; Linux x86-64/AArch64 use
a second `PT_LOAD` with `PF_R` only plus an alloc-only `.rodata` section. RIP- or
ADR-relative arena fixups are patched only after the final section/segment VA is
known, so static PIE remains relocation-free. Direct native `bytes.get` validates
descriptor offset/length and index before every load. For descriptors returned by
`fs.read`, x86-64 and AArch64 resolve offsets into a separate zero-initialized
runtime arena whose first eight bytes hold a monotonic committed cursor; guest
loads cannot address uncommitted bytes. The default standalone arena is bounded
at 64 KiB, mapped writable but non-executable, and a read commits its cursor only
after an exact-size host read succeeds. Windows x86-64 runtime tests cover real
files, repeated reads and oversize rejection; AArch64 currently has structural
ELF/opcode tests and still requires a Linux ARM64/QEMU runtime gate.

`print(ieee64)` / `eprint(ieee64)` use a deterministic, CRT-free canonical
hex-float representation shared across x86-64 and AArch64. Normal values render
as `[-]0x1.<13 hex digits>p+/-exp`, subnormals as
`[-]0x0.<13 hex digits>p-1022`, signed zero as `[-]0x0p+0`, and special values
as `inf`, `-inf` or `nan`. This representation preserves the exact binary64 bit
pattern instead of introducing platform-dependent decimal rounding. Windows
runtime tests cover normal values, signed zero, minimum subnormal, infinities,
NaN and separated stdout/stderr; ARM64 emitter tests cover the same synthesized
formatter path plus direct `write` syscall lowering.

PE executable/DLL section RVAs are computed from actual section sizes rather
than fixed 4 KiB assumptions. This became necessary once multiple process
runtime helpers pushed `.text` beyond one page; regression tests now cover large
IEEE64 stdout+stderr images so `.text`, `.idata/.edata` and `.reloc` cannot
silently overlap in virtual address space.

Compile-path performance can be reproduced with:

```powershell
go build -o E:\\temp\\swyp.exe ./cmd/swyp
python benchmarks/swyp/x64_compile_bench.py --swyp E:\\temp\\swyp.exe --output E:\\temp\\swyp-x64-compile-bench --repetitions 15
```

## Direct ARM64 backend — phase 1

`swyp core-arm64` emits AAPCS64 assembly directly from the same optimized SSA
and register-planning pipeline used by x86-64.

The current CFG assembly backend (`swyp-arm64-cfg-aapcs64-v1`) supports:

- multiple reachable blocks;
- jumps and conditional branches;
- SSA phi lowering on predecessor edges;
- i64/u64/bool values;
- explicit `ieee64` in D8–D15 with AAPCS64 FP argument/return registers;
- const/move/neg/not;
- add/sub/mul/div for `ieee64` and integer arithmetic/bitwise operations;
- signed, unsigned and IEEE floating-point comparisons;
- checked i64 overflow, including multiply using `smulh`;
- mixed GPR/FP phi lowering across CFG edges.
- GPR and `ieee64` FP stack spills through non-overlapping x29-relative frame regions;
- spilled FP parameters, operands, destinations, returns and phi copies.

The assembly CFG path still keeps floating-point native calls and strict finite
`f64` fail-closed. ARM64
assembly runtime execution has not been validated on this x86-64 workstation
because no AArch64 assembler/runtime is installed here; emitter tests and
`linux/arm64` cross-builds pass.

ARM64 now also lowers acyclic pure GPR-native calls:

- up to 7 `i64/u64/bool` arguments;
- AAPCS64 `x0..x7` argument bank;
- a 16-byte per-call status cell keeps SP aligned;
- the caller's own status pointer is persisted in its x29-relative frame because
  `x16` is caller-saved;
- recursive and FP-native calls fail closed.

The Swyp compiler itself cross-builds successfully for `linux/arm64`, including
`internal/coreir`, `cmd/swyp` tests and the CLI binary.

The x86-64 regression suite also contains an end-to-end pressure program that
forces six SSA GPR spills under the seven-register backend budget and executes
the resulting binary successfully. ARM64 spill lowering is covered by emitter
tests and linux/arm64 cross-compilation on this workstation.

```powershell
swyp core-arm64 -entry fn -o fn.s program.swyp
swyp core-arm64-pack -entry fn -o fn.swa64 program.swyp
swyp core-arm64-object -format elf -entry fn -o fn.o program.swyp
swyp core-arm64-object -format coff -entry fn -o fn.obj program.swyp
swyp core-arm64-object -format macho -entry fn -o fn.o program.swyp
swyp core-arm64-exe -entry fn -o fn program.swyp
swyp core-arm64-exe -pie -entry fn -o fn-pie program.swyp
```

`core-arm64-pack` now emits AArch64 machine-code words directly, without an
external assembler. `swyp-arm64-leaf-machine-aapcs64-v1` covers single-block,
spill-free `i64/u64/bool` functions using caller-saved x9-x15 plus x16 for the
status pointer. `swyp-arm64-cfg-machine-aapcs64-v1` adds branches/backedges,
register/spill phi copies and x29-free SP-relative GPR spill frames. Closed
acyclic GPR call graphs use `swyp-arm64-cfg-machine-calls-aapcs64-v1`: internal
calls are patched as `BL imm26`, caller x9-x15 values are conservatively saved in
the frame, the original status pointer and per-call status cell have dedicated
slots, and nested trap status propagates without relying on x16 surviving a
callee. `swyp-arm64-cfg-machine-fp-aapcs64-v1` adds explicit `ieee64`, separate
FP spill slots, D16-D23 allocation and FP phi lowering. Mixed GPR/FP closed call
graphs use `swyp-arm64-cfg-machine-fp-calls-aapcs64-v1`: AAPCS64 GPR and FP
argument banks are assigned independently, the status pointer occupies the next
GPR argument, and caller x9-x15 plus live D16-D23 values are preserved across
internal `BL` calls. Signed i64 add/sub/neg/mul retain checked overflow semantics;
multiply validates the high half via `smulh`. The `.swa64` artifact stores typed
entry metadata, ABI, SHA-256 and raw little-endian AArch64 instruction words.

`core-arm64-object` wraps the same internally relocated machine-code blob in a
deterministic native relocatable object **without invoking an assembler**. It
currently supports:

- `-format elf`: ELF64/AArch64 `ET_REL`, with `.text`, symbol/string tables and
  exported `swyp_core_<entry>`;
- `-format coff`: Windows ARM64 COFF `.obj`, deterministic zero timestamp,
  executable/readable `.text` and external `swyp_core_<entry>` symbol;
- `-format macho`: Darwin ARM64 `MH_OBJECT`, `__TEXT,__text`, `LC_SYMTAB` and the
  standard Darwin external symbol `_swyp_core_<entry>`.

The three formats are parsed back in tests with Go's `debug/elf`, `debug/pe` and
`debug/macho`. Linking/execution on real ARM64 remains a separate
hardware/toolchain validation step.

`core-arm64-exe` emits a standalone static **ELF64/AArch64 `ET_EXEC`** directly.
The image has one RX `PT_LOAD`, no `PT_INTERP`, no libc and no imported
libraries. `_start` reads `argc/argv` directly from the Linux process-entry
stack and generates the same strict typed parsing contract as x86-64:

- up to 7 `i64/u64/bool` values in the AAPCS64 GPR bank;
- up to 8 `ieee64` values in the independent FP bank;
- mixed GPR/FP signatures are staged independently into `x0..x6` and `d0..d7`;
- integer overflow/range errors, malformed bool/FP tokens or wrong argc fail
  closed with process exit code `2`;
- decimal `ieee64` parsing supports sign, fractional syntax and `e/E` exponent
  directly in AArch64 FP instructions (`SCVTF`, `FADD`, `FMUL`, `FDIV`).

The wrapper passes the trailing status pointer in the next GPR, calls the packed
AAPCS64 entry with `BL`, checks backend status and terminates with Linux AArch64
syscall `exit(93)`. The executable is validated structurally with `debug/elf`,
opcode-level emitter tests and `linux/arm64` compiler cross-builds;
native/emulated execution is still pending because this Windows workstation has
neither ARM64 hardware nor QEMU/WSL distro installed.

`core-arm64-exe -pie` likewise emits a zero-based `ET_DYN` image. Its AArch64
wrapper and packed backend use `BL`/conditional PC-relative control flow and
stack-relative data only, so there are no absolute text relocations to repair at
load time. Structural tests verify `ET_DYN`, zero-based `PT_LOAD` and relative
entry placement.

## Backend register planning

`swyp core-plan` runs Core lowering + optimization + CFG liveness +
interference analysis and emits deterministic mutable-slot **and SSA** register
plans. The SSA plan versions every write and includes phi-aware liveness, which
is the preferred input for the direct native backends.

```powershell
swyp core-plan -entry count_primes -gprs 10 -fps 8 program.swyp
```

Integer/boolean slots and floating-point slots are allocated from separate
banks. When the requested bank is too small, the plan reports explicit spill
slots. This is the contract the direct x86-64 and ARM64 emitters will consume.

The SSA allocator now uses a sparse adjacency representation internally rather
than materializing an N×N bool matrix for every allocation. The dense
`SSAInterferenceGraph` API remains available for diagnostics/tests.

On the i7-9700 workstation, a 1,024-operation sparse SSA chain measured:

| Path | Time | Heap bytes | Allocations |
|---|---:|---:|---:|
| sparse allocator | ~2.18 ms | ~329 KB | 2,088 |
| dense interference view | ~3.27 ms | ~1.50 MB | 3,111 |

This is one synthetic workload, not a universal compiler-speed claim. It does
show why the allocator should scale with actual interference edges rather than
the square of SSA value count.

## Interprocedural optimization

Optimized Core now performs bounded iterative inlining for small pure helpers:

- single-block;
- call-free leaf at the time of a round;
- at most 24 instructions;
- no effects or capability requirements;
- call-by-value parameters are copied into fresh local slots;
- at most 8 inlining rounds.

The iterative rounds allow chains such as `top -> middle -> leaf` to become
call-free before SSA/native lowering without introducing general native call
semantics into the backend. The optimization report exposes `InlinedCalls`,
and fast Core AOT reports `inlined=N`.

## Persistent compiler process

`swyp core-server` keeps the compiler alive and accepts bounded JSONL requests
on stdin/stdout. It opens no network port. IDE/LSP/build integrations can own
the child process and avoid repeated Go process startup.

```json
{"id":"1","action":"build","args":["-entry","sum_to","-profile","fast","-o","sum.exe","sum.swyp"]}
{"id":"2","action":"run","args":["-profile","fast","-entry","sum_to","sum.swyp","100"]}
{"id":"3","action":"check","args":["-entry","sum_to","sum.swyp"]}
{"id":"4","action":"eval","file":"editor.swyp","source":"fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}","entry":"add","profile":"turbo","values":["20","22"]}
{"id":"bye","action":"shutdown"}
```

The server reuses the exact `core-build` implementation and content-addressed
AOT cache, so persistent mode changes startup cost only, not program semantics.

`eval` is the IDE/agent fast path: the client sends the current source buffer
directly, so unsaved files require no temporary file. The server caches the
optimized prepared Core executable by source hash + logical file + entry and
invalidates it automatically when the source changes.

The cache is bounded to 256 logical file/entry/profile programs per server
process. `safe` eval keeps the unoptimized exact-fuel executable; `fast` and
`turbo` cache the optimized executable.

### Current persistent measurements

On the i7-9700 workstation, measured 2026-09-29:

- Core frontend `ParseCore -> CoreIR -> Optimize -> EmitNativeC`: ~**0.112 ms**
  median benchmark operation;
- cached CLI AOT build in a fresh process: ~**33 ms** median;
- persistent `core-server` cached AOT materialization: ~**15.6 ms** median;
- persistent embedded `run -profile fast`: ~**0.227 ms** median, p95 < 0.30 ms;
- persistent `check`: ~**0.239 ms** median, p95 < 0.30 ms.

These are workstation measurements, not universal guarantees. Reproduce with:

```powershell
go build -o E:\temp\swyp.exe ./cmd/swyp
python benchmarks/swyp/core_server_bench.py \
  --swyp E:\temp\swyp.exe \
  --output E:\temp\swyp-server-bench \
  --repetitions 50
```

The implication is architectural: for interactive development, keep Swyp
persistent and use embedded Core execution. AOT should be materialized for
release or when a native executable is explicitly required.

## Direct native bounded network fetch

`http_fetch(ipv4, port, path)` lowers to the standalone-only `net.fetch` Core
effect and requires the explicit symbolic capability `network_fetch`. This is
not a general HTTP client and intentionally does not inherit authority from
`net.connect`.

The native v1 contract is bounded and deterministic:

- host is an IPv4 literal; there is no DNS lookup;
- transport is plaintext HTTP/1.1 only; TLS is unsupported rather than silently
  downgraded;
- the request is a fixed `GET` with `Connection: close`; redirects are returned
  as raw response bytes and are never followed;
- paths must begin with `/`, contain visible ASCII only and are capped at 2048
  bytes;
- response storage is the same bounded RW/non-executable monotonic process arena
  used by `fs.read`; the cursor is committed only after clean EOF;
- an exactly-full arena is probed for one additional byte so overflow cannot be
  mistaken for success;
- connection establishment plus send/receive are bounded by fixed five-second
  runtime timeouts;
- socket handles/descriptors are closed on every post-creation path and Windows
  also balances `WSAStartup`/`WSACleanup`.

Windows x86-64 has real loopback runtime coverage for request formation, policy
rejection and oversized responses. Linux x86-64 and Linux AArch64 use direct
syscalls with no libc or resolver dependency; AArch64 remains structurally and
cross-build validated until a real Linux/AArch64 runtime is available.
