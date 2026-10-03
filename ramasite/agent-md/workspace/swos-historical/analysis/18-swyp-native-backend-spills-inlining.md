# Swyp Native Backend Upgrade — 2026-09-29

Workspace: E:\nexus\swyp
Status: implementation in progress; no commit/push/deploy.

## Validated in this pass

### x86-64 GPR spill lowering
The CFG x64 backend now consumes SSA register plans containing GPR spills.

Implemented:
- rbp-relative stack spill frame
- spilled function parameters
- spilled instruction operands
- spilled instruction destinations
- spilled return values
- spilled branch conditions
- phi edge copies with register<->spill and spill<->spill movement
- scratch register policy using r10/r11/rax
- FP spills still fail closed

Important correctness fix:
- the CFG public Win64 wrapper previously held the status pointer in caller-saved r10 across the call to the raw function.
- spill lowering uses r10 as scratch, causing an access violation after return.
- the wrapper now stores the status pointer in its 40-byte call frame and reloads it after the raw call.

Proof:
- a four-parameter pressure program was planned with 7 GPRs
- core-plan reported 6 mutable-slot spills and 6 SSA spills
- core-x64-build compiled and executed it successfully
- result for inputs 1,2,3,4 = 56
- existing x64 add/loop/overflow regression tests also passed

### ARM64 GPR spill lowering
The CFG AAPCS64 backend now supports GPR stack spills.

Implemented:
- x29-relative spill frame
- spilled parameters
- spilled operands/destinations
- spilled return values
- spilled branch conditions
- phi spill movement
- IEEE64 comparison -> spilled bool result
- FP spills remain fail closed

Validation:
- ARM64 emitter tests passed
- linux/arm64 cross compilation succeeded for:
  - internal/coreir test binary
  - cmd/swyp test binary
  - swyp CLI
- no claim of ARM64 runtime execution on the current x86-64 workstation

### Static gates
- gofmt: clean
- Bridge go vet/check_files on changed optimizer/backend files: 0 problems
- gopls diagnostics on changed files: 0 errors
- git diff --check: PASS
- git diff --cached --check: PASS

## Implemented but awaiting executable unit gate

### Small pure helper inlining
Optimizer now has a conservative inliner intended to eliminate common native-backend calls before SSA lowering.

Eligibility:
- callee is not recursive self-call
- no effects/capability requirements
- exactly one block
- return terminator
- no nested calls
- <= 24 instructions
- valid arity/result

Correctness design:
- inlined parameters receive local caller slots and explicit moves from arguments
- this preserves call-by-value even if the helper reassigns a parameter
- callee temporaries receive fresh caller slots
- existing copy propagation/dead-value removal/slot compaction clean up the expanded IR
- OptimizationReport now includes InlinedCalls
- core-build output reports inlined=N

Added tests:
- two calls to a pure inc helper are removed and preserve results
- effectful helper is not inlined
- parameter reassignment preserves call-by-value semantics
- x64 end-to-end helper program must compile call-free and return 42

Current blocker:
- workstation pressure repeatedly reached CPU 99-100% and free RAM ~0.4-1.0 GB
- Bridge correctly rejected heavy go test execution below its 1 GB / <=85% CPU admission threshold
- no unrelated processes were killed or deprioritized
- static compiler diagnostics are green, but these new inlining tests must still execute before the inliner is considered promoted

## Existing performance evidence retained

- ParseCore -> CoreIR -> Optimize -> EmitNativeC: ~0.112 ms on i7-9700
- persistent core-server RunFast: ~0.227 ms median, p95 <0.30 ms
- persistent check: ~0.239 ms median, p95 <0.30 ms
- cached AOT fresh CLI: ~33 ms median
- persistent cached AOT materialization: ~15.6 ms median
- Core fast/turbo common small-frame paths remain designed for zero allocations

## Next gates when workstation pressure drops

1. go test targeted optimizer inlining
2. x64 end-to-end helper inlining test
3. full go vet ./...
4. full go test -count=1 ./...
5. rerun Core Run/Fast/Turbo benchmark
6. benchmark x64 pressure program with spills vs C-AOT
7. if green, update Swyp version and roadmap

## Next architecture milestone after promotion

Priority order:
1. finish inlining promotion
2. general native calls or broader interprocedural inlining
3. FP spill lowering
4. packed CFG machine-code backend (remove assembler/linker for non-leaf CFG)
5. compact typed bytecode for embedded/turbo cache
6. SIMD/vector IR
7. tensor IR + GPU/NPU lowering
