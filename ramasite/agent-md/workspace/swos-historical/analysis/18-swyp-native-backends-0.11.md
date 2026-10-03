# Swyp 0.11 Native Backend Milestone — 2026-09-29

## Implemented directly in E:\nexus\swyp

### x86-64 CFG backend
- Existing SSA, liveness and interference-based register allocator retained.
- Added CFG-aware direct x86-64 assembly backend:
  - multiple reachable blocks;
  - conditional branches and jumps;
  - SSA phi nodes lowered on predecessor edges;
  - balanced stack parallel copies preserve phi cycles;
  - checked i64 overflow;
  - integer/bool subset remains call-free and spill-free.
- core-x64 and core-x64-build use ABI:
  swyp-x64-cfg-win64-v1.
- core-x64-pack intentionally remains strict leaf-v1 machine-code artifact path.

### Real x64 CFG validation
- if/else executable test PASS.
- loop/backedge/phi test PASS.
- sum_to produced:
  - 0 -> 0
  - 1 -> 1
  - 10 -> 55
  - 100 -> 5050

### x64 compile-path measurement
Evidence:
E:\CEO\swyp-x64-compile-20260929-094233\report.json

5-repetition workstation run medians:
- direct .swx64 pack: 17.164 ms
- direct x64 assembly emit: 18.101 ms
- x64 assembly + GCC assembler/linker: 411.940 ms
- C AOT reference backend: 380.672 ms

The direct Swyp-owned pack/codegen path was roughly 22x faster to produce an artifact than the C-AOT path in this short workstation run. Process startup is included. This is not a universal language-wide claim.

### ARM64 backend
Added direct AAPCS64 backend:
- leaf emitter;
- CFG-aware emitter;
- branches/jumps;
- SSA phi edge lowering;
- i64/u64/bool;
- const/move/neg/not;
- add/sub/mul/bitwise;
- signed/unsigned comparisons;
- checked i64 add/sub/neg;
- checked signed multiply via low mul + smulh/sign-extension comparison.

Command:
swyp core-arm64 -entry fn -o fn.s program.swyp

ABI:
swyp-arm64-cfg-aapcs64-v1

### ARM64 validation
- ARM64 leaf emitter tests PASS.
- ARM64 CFG structural tests PASS.
- Swyp compiler cross-build PASS for linux/arm64:
  - internal/coreir test binary
  - cmd/swyp test binary
  - CLI binary
- No AArch64 assembler/runtime is installed on this workstation, so generated assembly has not yet been executed on ARM hardware. This limitation is explicit.

### Existing fast paths retained
- zero-allocation Core fast runtime;
- RunTurbo;
- persistent core-server;
- content-addressed AOT cache;
- Semantic Core verifier;
- component language/codegen;
- C AOT differential backend.

## Gate results

Targeted SSA/liveness/regalloc/x64/ARM64:
PASS

Full:
python benchmark script compile checks
go vet ./...
go test -count=1 ./...

PASS:
- 8 Go packages OK
- 0 failed

Final short gate after version/docs:
- cmd/swyp targeted native/server tests PASS
- Swyp version prints 0.11.0-experimental
- git diff --check PASS

## Next performance milestone

1. Floating-point register banks:
   - x86-64 XMM;
   - ARM64 D/V registers;
   - strict f64 finite semantics;
   - explicit ieee64 hardware semantics.
2. Spills.
3. Direct calls / interprocedural ABI.
4. Machine-code CFG backend parity with assembly backend.
5. Range/refinement analysis to remove checks proven unnecessary.
6. SIMD/vector IR.
7. Tensor IR and GPU/NPU lowering.
