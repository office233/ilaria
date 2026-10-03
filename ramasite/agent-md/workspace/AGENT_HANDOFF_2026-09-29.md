# NEXUS HANDOFF — Swyp Lang + SwypikOS + Ilaria
Date: 2026-09-29
Workspace: E:\nexus
Branch: agent/nexus-clean-swyp-fast
HEAD observed: a5a8175
Swyp version observed: Swyp Lang 0.14.0-experimental

## 0. IMPORTANT — READ THIS BEFORE TOUCHING THE REPO

This workspace is intentionally in the middle of a large migration plus concurrent agent work.

Current observed git status:
- 929 status entries total
- 133 untracked files
- many staged/unstaged renames from the root -> ilaria/swyp/swypik-os split
- many Swyp backend files are still untracked
- many SwypikOS optimization files are modified/untracked

DO NOT:
- git reset --hard
- git clean -fd / -fdx
- stash the whole repository
- checkout/restore broad directories
- move projects out of E:\nexus
- commit/push/deploy unless explicitly requested
- rewrite or delete concurrent-agent changes just because they are untracked

Always:
1. work directly in E:\nexus
2. read E:\nexus\AGENTS.md
3. read the nested product AGENTS.md before editing that product
4. inspect git status for the exact files you intend to touch
5. preserve unrelated concurrent edits
6. use small patches and run targeted tests before full gates

The product boundaries are:
- E:\nexus\ilaria     = cognition/model/runtime/training/memory
- E:\nexus\swyp       = language/compiler/IR/contracts/codegen
- E:\nexus\swypik-os  = OS authority/kernel/devices/UI/compute fabric/effects

There is no root Go module. E:\nexus\go.work ties the modules together.

---

# 1. REPOSITORY RESTRUCTURE — DONE

The old mixed root was split into first-class products:

E:\nexus\
  ilaria\
  swyp\
  swypik-os\
  .github\
  go.work
  AGENTS.md
  README.md

Swypik native kernel seed lives at:
- E:\nexus\swypik-os\kernel

The migration was verified earlier with:
- Ilaria go vet + tests
- Swyp go vet + tests
- SwypikOS go vet + tests
- native kernel build

Git recognized the bulk migration primarily as renames after staging, but the current workspace has accumulated more concurrent work since then. Do not assume the earlier status counts are still the final staging plan.

---

# 2. SWYP COMPONENT CONTRACTS / CODEGEN — DONE

Swyp .swyp component specs are now real source-of-truth for protocol DTOs, not just documentation.

Implemented:
- record declarations
- component parser/checker
- canonical JSON manifests
- Go DTO generation
- CLI:
  - swyp component check
  - swyp component compile
  - swyp component go

Important specs:

Ilaria Myriad:
- E:\nexus\ilaria\specs\myriad.swyp
- E:\nexus\ilaria\specs\myriad.manifest.json
- E:\nexus\ilaria\generated\myriad\types_gen.go

SwypikOS Compute Fabric:
- E:\nexus\swypik-os\specs\compute-fabric.swyp
- E:\nexus\swypik-os\specs\compute-fabric.manifest.json
- E:\nexus\swypik-os\generated\computefabric\types_gen.go

SwypikOS Control Kernel:
- E:\nexus\swypik-os\specs\control-kernel.swyp
- E:\nexus\swypik-os\specs\control-kernel.manifest.json
- E:\nexus\swypik-os\generated\controlkernel\types_gen.go

Generated important DTOs include:
- CorticalRequest
- CorticalResponse
- ExpertGenome
- TrainingJob
- CandidateDelta
- EffectEvidence

CI was extended to regenerate manifests + Go DTOs and reject drift.

Do not edit generated DTOs manually.

---

# 3. SWYP LANG — CURRENT BASELINE

Observed version:
- Swyp Lang 0.14.0-experimental

The compiler evolved significantly beyond the original frontend.

## 3.1 Implemented compiler/runtime capabilities

Implemented and previously regression-tested:
- Semantic Core IR
- safe / fast execution profiles
- explicit ieee64 semantics
- optimizer
- constant folding
- copy propagation
- dead instruction/block elimination
- CFG simplification
- small pure-function inlining
- bounded acyclic CFG inlining
- loops deliberately remain native calls instead of being aggressively inlined
- call-by-value preservation in the inliner
- SSA
- phi nodes
- liveness
- deterministic register allocation
- GPR spills
- x86-64 direct backend
- ARM64 direct assembly backend
- scalar native calls on assembly/native build paths
- checked i64 overflow propagation
- compact Turbo bytecode
- compact Turbo terminators
- persistent compiler/runtime process
- content-addressed AOT cache
- packed x86-64 machine-code module format

## 3.2 Persistent compiler/runtime

Command:
- swyp core-server

JSONL stdin/stdout only; no network listener.

Actions:
- build
- run
- check
- shutdown

This is the intended path for IDE/LSP/SwypikOS interactive development because it avoids process startup.

Measured on the i7-9700 workstation:
- ParseCore -> CoreIR -> Optimize -> EmitNativeC: ~0.112 ms
- persistent RunFast: ~0.227 ms median
- persistent check: ~0.239 ms median
- p95 for the small interactive cases: < ~0.30 ms

These are workstation measurements, not universal guarantees.

## 3.3 AOT cache

core-build supports:
- -cache-dir auto|off|DIR

Cache key includes semantic build inputs such as:
- source bytes
- entry point
- profile
- CPU target
- LTO/strip options
- compiler identity
- platform/cache version

Measured earlier:
- cold AOT build ~555 ms
- cached fresh CLI build ~33 ms
- persistent cached AOT materialization ~15.6 ms

The frontend was measured at ~0.112 ms, proving CLI process startup/output materialization dominates warm CLI latency.

## 3.4 Turbo execution

Turbo path now uses compact typed opcodes and cold side tables.

Important:
- equality/inequality for matching i64/u64/bool/f64/ieee64 types has direct numeric opcode handling
- cross-type Core equality retains the semantic fallback because Core intentionally defines cross-type eq/ne semantics
- compact terminators are used for return/jump/branch/unreachable

## 3.5 x86-64 backend

Validated previously:
- branches
- loops
- phi copies
- GPR register allocation
- GPR stack spills
- native scalar calls on assembly/native build path
- checked signed overflow
- end-to-end spilled executable on Windows

Important bug already fixed:
- the public CFG wrapper held the status pointer in caller-saved R10
- spill lowering also used R10 as scratch
- this produced an access violation after the raw call
- wrapper now preserves/reloads status correctly

A pressure program forced 6 SSA GPR spills and executed correctly through core-x64-build.

## 3.6 ARM64 backend

Implemented:
- CFG assembly
- branches / loops / phi
- GPR spills
- spilled params/operands/results/returns/branch conditions
- x29 frame
- mixed GPR/FP phi behavior where supported
- linux/arm64 cross compilation

Validated:
- ARM64 emitter tests
- cross-compile of coreir tests
- cross-compile of cmd/swyp tests
- cross-compile of Swyp CLI

Not yet claimed:
- real runtime execution on ARM hardware in this workstation session
- FP spills
- complete packed ARM64 object/machine-code pipeline

---

# 4. SWYP PACKED X64 MACHINE CODE — VERY IMPORTANT CURRENT PENDING AREA

Packed .swx64 support was extended from leaf-only toward real CFG machine code.

Existing/implemented:
- leaf ABI
- separate CFG machine ABI:
  swyp-x64-cfg-machine-win64-v1
- branches
- loops/backedges
- rel32 fixups
- SSA phi edge copies
- packed module hashing/metadata
- core-x64-pack fallback leaf -> CFG
- branch pack test
- loop pack test

The next increment was implemented but NOT fully runtime-promoted before focus moved to SwypikOS resource optimization:

### Latest pending packed-spill work

Files include:
- swyp/internal/coreir/x64_machine.go
- swyp/internal/coreir/x64_machine_cfg.go
- swyp/internal/coreir/x64_machine_cfg_windows_test.go
- swyp/internal/coreir/x64_module.go
- swyp/internal/coreir/x64_module_test.go
- swyp/cmd/swyp/core_x64_pack.go
- swyp/cmd/swyp/core_x64_pack_test.go

Implemented in the pending increment:
- RBP-relative packed GPR spill frame
- spilled parameters
- spilled instruction sources/destinations
- spilled returns
- spilled branch conditions
- spilled phi copies
- R10/RDX/RAX scratch scheme
- R11 reserved for status pointer
- Windows/amd64 test-only executable-memory harness for directly executing generated machine bytes

Static checks were clean when last inspected, but the FINAL runtime test pass for this exact latest packed-spill increment was not completed before switching to SwypikOS optimization.

### FIRST THING THE NEXT AGENT SHOULD DO IN SWYP

Run targeted tests FIRST:

cd E:\nexus\swyp

gofmt -w internal\coreir\x64_machine.go internal\coreir\x64_machine_cfg.go internal\coreir\x64_module.go internal\coreir\x64_machine_cfg_windows_test.go cmd\swyp\core_x64_pack.go cmd\swyp\core_x64_pack_test.go

go test -count=1 ./internal/coreir ./cmd/swyp -run 'Test(X64.*Module|CoreX64PackCommand|X64CFGMachineCodeExecutes)'

Then:

go vet ./...
go test -count=1 ./...

Do not continue packed-call/FP work until the current packed-spill machine bytes execute correctly.

If the direct-execution harness exposes a bug:
- inspect frame layout
- inspect R11 status preservation
- inspect RBP spill offsets
- inspect push/pop interaction with phi copies
- inspect rel32 branch fixups
- compare against the already-working assembly CFG backend

---

# 5. SWYP — NEXT COMPILER ROADMAP

After packed-spill validation, recommended priority order:

1. packed CFG GPR spill promotion
2. packed native scalar calls
3. FP spill lowering
4. packed FP support
5. direct ARM64 packed/object backend
6. branch-sensitive range/refinement analysis
7. proven bounds/overflow-check elimination only when semantically proven safe
8. SIMD/vector IR
9. AVX2/AVX-512 lowering where available
10. NEON lowering on ARM64
11. tensor IR
12. GPU/NPU lowering
13. SwypikOS hardware-manifest-driven target selection
14. PGO/code layout only after reproducible benchmark evidence

Keep C AOT as a differential/reference backend until direct backends have feature parity.

Do NOT chase parser micro-optimizations first:
- measured frontend is already ~0.112 ms for the benchmarked small Core pipeline.

---

# 6. SWYPIKOS LOW-RESOURCE OPTIMIZATION — DONE AND FULL-GREEN

The user explicitly requires SwypikOS to stay very light on CPU/RAM.

A resource audit and optimization pass was completed.

## 6.1 Global resource policy

File:
- swypik-os/core/resource/policy.go

Profiles now deliberately bound:
- background CPU
- background GPU
- worker count
- status polling
- search corpus loaded into RAM
- graph checkpoints
- process memory policy
- GOGC
- training delta size/count
- chat history
- document size
- app catalog
- wallet history
- P2P peers
- Hive tasks
- P2P inspection queue/payload

Current important values:

### Phone
- background CPU: 3%
- background GPU: 8%
- background workers: 1
- status poll: 30 s
- search files/docs: 1000 / 1000
- search text/doc: 4096 bytes
- graph checkpoints: 4
- policy memory limit: 128 MB
- GOGC: 50
- training delta params: 32768
- pending deltas: 16
- chat history: 20 messages
- max document: 128 KiB
- app catalog: 32
- wallet history: 128
- resident peers: 16
- Hive tasks: 16
- P2P inspection queue: 4
- P2P inspection payload max: 2048 bytes

### Balanced
- background CPU: 8%
- background GPU: 20%
- background workers: 2
- status poll: 10 s
- search files/docs: 5000 / 5000
- graph checkpoints: 8
- policy memory limit: 192 MB
- GOGC: 75
- training delta params: 131072
- pending deltas: 64
- chat history: 60
- max document: 512 KiB
- app catalog: 128
- wallet history: 512
- resident peers: 128
- Hive tasks: 128
- P2P inspection queue: 8

### Performance
Still bounded, but larger:
- background CPU 25%
- GPU 50%
- 4 workers
- 512 MB policy memory limit
- 125 GOGC
- max resident peers 512
- max Hive tasks 256
- etc.

## 6.2 Go runtime policy

Important fix:
- ApplyRuntime used to relax a stricter desktop-local memory/GOGC limit.
- Example: desktop main set a strict ~24 MiB soft ceiling, then Balanced policy could reset it to hundreds of MB.
- Fixed: global resource policy may tighten a pre-existing process-local limit, never relax it.

Go scheduler caps:
- phone: max GOMAXPROCS 1
- balanced: max GOMAXPROCS 2
- performance: all logical CPUs

This reduced idle threads/handles in measured phone/balanced runs.

## 6.3 Resource Governor

New:
- swypik-os/core/resource/governor.go
- tests in governor_test.go

Governor provides:
- fixed background worker slots
- cooperative CPU duty-cycle cooldown
- context cancellation
- preemptible background work contract

Swarm training now has:
- ExecuteTrainingMicroBatchContext(ctx,...)
- legacy method preserved as wrapper
- training work routed through Resource Governor

Important future rule:
REAL GPU kernels must observe ctx or equivalent cancellation/preemption; the current simulator cannot prove real GPU preemption.

## 6.4 ActionGraph

Before:
- one goroutine per active node
- most goroutines blocked on a semaphore

Now:
- fixed worker pool
- goroutine count bounded by MaxBackgroundWorkers
- existing max-parallelism regression test remains green

This prevents large agent graphs from causing scheduler/stack spikes.

## 6.5 UI memory optimization

Windows UI remains native Win32/GDI+, no browser/WebView.

Existing good behavior retained:
- event-driven GetMessage loop
- live/approval timer 250 ms
- idle timer around once/minute
- static wallpaper quarter-resolution (1/16 full bitmap memory)

New:
- text measure cache: ~20,000 -> 2,048 entries
- block height cache: ~4,000 -> 512 entries
- desktop command history profile-aware
- desktop log block retention profile-aware
- notification queue retention profile-aware
- phone: 20 history messages, max ~80 log blocks/tab, notification queue max 40
- balanced: 60 history messages, max ~240 logs/tab
- performance: up to original larger bounds

### Adaptive full-screen backbuffer

Full-screen 32-bit backbuffer can cost approximately:
- 1080p: ~7.9 MiB
- 1440p: ~14.1 MiB
- 4K: ~31.6 MiB

New behavior:
- phone/balanced release the full-resolution backbuffer after ~2 seconds idle
- it is recreated on the next real paint
- performance profile keeps it warm

UI tests for this behavior are green.

## 6.6 Long-running resident state

### Control Kernel EventStore

Major memory fix:
- durable event journal remains append-only source of truth on disk
- EventStore used to also retain every historical Event in []Event for the entire process lifetime
- after OpenKernel replay, store.DisableEventRetention() releases the replay snapshot
- future appended events are persisted to disk and applied to Projection, not duplicated forever in RAM

Projection remains active in-memory state.

Do not remove durability/hash-chain behavior.

### Hive
- phone peers/tasks reduced to 16/16
- resident task history now drops large Payload bytes after routing
- caller task object is not mutated
- avoids retaining frames/model inputs/activation shards in local history

### Federated/P2P
- phone training delta max reduced to 32768 params
- pending deltas 16
- resident peers 16
- inspection queue 4
- inspection payload is capped
- P2P peer map has eviction

### Cyber
- history profile-aware and bounded
- uses reuse/copy instead of reslicing old backing arrays indefinitely

### Notifications
- profile-aware bounded urgent/digest queues

### Ilaria OS client
- chat history already bounded by resource policy

### Wallet
- history bounded by resource policy

### Agent runtime
Already bounded:
- max steps <=16
- persisted events <=128
- status snapshot only recent 32 events
No extra change needed.

### Search
Already profile-bounded:
- max docs
- max text bytes
- index replay truncation by profile
No lazy-open implementation was completed in this pass.

### Docs
AppendText word count now updates incrementally:
- old behavior rescanned entire document after every append
- new behavior counts only appended text
- regression compares incremental value with full recount

---

# 7. SWYPIKOS VALIDATION STATUS

Targeted optimized regression:
- 12 packages OK
- 0 failed

Full regression after major resource changes:
- go vet ./...
- go test -count=1 -timeout 180s ./...
- 45 packages OK
- 0 failed

A later full regression after:
- adaptive backbuffer
- runtime caps
- docs optimization
also passed:
- 45 packages OK
- 0 failed

Use these gates after further OS changes:

cd E:\nexus\swypik-os
go vet ./...
go test -count=1 -timeout 180s ./...

---

# 8. REAL SWYPIKOS RESOURCE MEASUREMENTS

Benchmark binaries/results were kept outside the repo under E:\CEO.

Important reports/results:
- E:\CEO\projects\swos\analysis\19-swypikos-low-resource-baseline.md
- E:\CEO\swypik-resource-bench-v2\resource-results-v2.json
- E:\CEO\swypik-resource-bench-v4\resource-results-v4.json

Measurement method:
- optimized GUI build
- -trimpath
- -ldflags "-H=windowsgui -s -w"
- fresh isolated workspace/data per process
- 4 s startup stabilization
- 5 s idle CPU window
- process created by benchmark only
- only benchmark PID was stopped afterward
- no existing user process was killed

## Stable measured behavior

Phone v4:
- Working Set ~20.17–20.28 MB
- Private commit ~49.03–49.04 MB
- idle CPU 0.000% in sampled windows
- ~10 threads
- ~187 handles

Balanced v4:
- one startup/first-run Working Set outlier ~57.8 MB
- steady later sample ~19.96 MB
- private commit ~49–50 MB
- idle CPU ~0–0.08%
- ~10–12 threads
- ~195–201 handles

Interpretation:
- steady Working Set target under 30 MB is achieved in these measurements
- idle CPU is effectively zero on phone and very low on balanced
- Private commit has a ~49 MB floor on this Windows process, including Go runtime, thread stacks, Win32/GDI/GDI+/DLL committed memory
- GOMEMLIMIT is NOT the same thing as total Private Memory
- do not fake lower memory using EmptyWorkingSet or other cosmetic trimming

Open question:
- investigate the balanced first-run Working Set spike (~58 MB) separately if startup peak is a hard product requirement

---

# 9. SWYPIKOS — NEXT RESOURCE WORK

Recommended next tasks:

1. automate the current manual idle benchmark as a manual/non-flaky performance harness
2. separately measure startup peak Working Set/private commit
3. measure resource use with:
   - real loaded search index
   - active agent run
   - active P2P training
   - many peers
   - device synthesis
4. wire Resource Governor into every real background compute path, not only the current swarm training entry
5. real GPU kernels must support cancellation/preemption
6. installer/device synthesis should automatically select phone/balanced/performance profile from hardware + device class
7. investigate search lazy-open only if startup profiling shows index replay is materially responsible
8. keep UI event-driven; do NOT reintroduce fixed 60/30 FPS idle loops
9. benchmark native kernel services separately from the Windows-hosted desktop process
10. define hard budgets per device class:
    - idle CPU
    - steady Working Set
    - startup peak
    - private commit
    - threads
    - handles
    - P2P resident bytes
    - training duty cycle

---

# 10. ILARIA STATUS RELEVANT TO THIS HANDOFF

The repository separation moved Ilaria under:
- E:\nexus\ilaria

Swyp Myriad contracts/codegen exist.

The broader requested Ilaria direction remains much larger than this compiler/OS pass:
- original Ilaria architecture
- RGBA
- cortex
- hippocampus
- synapses/memory
- distributed expert/P2P vision
- no dependency on BitNet as the product identity

This handoff did NOT finish a new from-scratch Ilaria foundation training architecture. The recent implementation focus was:
1. repo separation
2. Swyp compiler/runtime
3. SwypikOS resource optimization

Before editing Ilaria:
- read E:\nexus\ilaria\AGENTS.md
- respect all restricted/private/generated/model-data paths defined there
- do not assume model weights/data are safe to inspect or commit

---

# 11. KNOWN GIT / INTEGRATION RISK

Observed at handoff time:

Branch:
- agent/nexus-clean-swyp-fast

HEAD:
- a5a8175

Git status was extremely dirty:
- 929 status entries
- 133 untracked

Examples:
- many migration renames are staged/partially staged
- many Swyp backend files are untracked
- many SwypikOS optimized files are modified/untracked
- concurrent agent work is present

Do NOT try to make git status "clean" by destructive cleanup.

Recommended integration procedure:
1. inspect root git status
2. identify ownership of each file touched by the next task
3. run targeted tests
4. stage only a coherent logical group if/when user requests commit
5. use git diff --check before committing
6. do not push without explicit instruction

---

# 12. EXACT NEXT ACTIONS FOR THE NEXT AGENT

## Phase A — Promote the latest Swyp packed-spill work

cd E:\nexus\swyp

1. Inspect:
   git status --short -- internal/coreir cmd/swyp

2. Run:
   gofmt -w internal\coreir\x64_machine.go internal\coreir\x64_machine_cfg.go internal\coreir\x64_machine_cfg_windows_test.go internal\coreir\x64_module.go cmd\swyp\core_x64_pack.go cmd\swyp\core_x64_pack_test.go

3. Targeted tests:
   go test -count=1 ./internal/coreir ./cmd/swyp -run 'Test(X64.*Module|CoreX64PackCommand|X64CFGMachineCodeExecutes)'

4. If green:
   go vet ./...
   go test -count=1 ./...

5. Only after full green:
   update PERFORMANCE/ROADMAP if packed spills were not already documented as promoted.

## Phase B — Continue Swyp backend

Priority:
1. packed native calls
2. FP spills
3. packed FP
4. ARM64 packed/object backend
5. branch-sensitive range analysis
6. SIMD/NEON
7. tensor/GPU/NPU

## Phase C — Keep SwypikOS resource baseline intact

Before touching OS:
cd E:\nexus\swypik-os
go vet ./...
go test -count=1 -timeout 180s ./...

Do not weaken:
- phone/balanced resource limits
- Resource Governor
- adaptive backbuffer release
- bounded histories/caches
- EventStore post-replay memory release
- fixed ActionGraph worker pool
- event-driven idle behavior

## Phase D — Hardware-aware resource synthesis

Next high-value OS feature:
- auto-select resource profile from detected hardware/device kind
- phone -> low power
- workstation -> balanced/performance depending power/thermal state
- vehicle/robot -> safety/latency-specific policy
- dynamically reduce training when:
  - foreground is active
  - battery low
  - thermal pressure high
  - memory pressure high

This should eventually be owned by Control Kernel / Compute Fabric rather than ad-hoc feature flags.

---

# 13. SUCCESS CRITERIA GOING FORWARD

Swyp:
- no semantic regression for speed
- direct backends always differential-tested against Core/C reference
- no silent unchecked arithmetic
- packed artifacts verified before execution
- sub-ms persistent interactive pipeline preserved

SwypikOS:
- idle CPU close to zero
- steady desktop Working Set ~20 MB class on measured Windows baseline
- no unbounded resident histories/caches
- P2P/training yields instantly to foreground/resource pressure
- no fake memory trimming claims
- full test suite stays green
- device-specific policy generated automatically

Ilaria:
- model runtime remains separate from OS authority
- Swyp/Control Kernel contracts define effects and permissions
- P2P learning must be verifiable, bounded and preemptible
- no background compute may degrade device responsiveness

---

# 14. REFERENCE REPORTS ALREADY CREATED

Useful prior analysis files:
- E:\CEO\projects\swos\analysis\17-swyp-performance-0.10.md
- E:\CEO\projects\swos\analysis\18-swyp-native-backend-spills-inlining.md
- E:\CEO\projects\swos\analysis\19-swypikos-low-resource-baseline.md

Use them for detailed benchmark history, but trust current code/tests over stale prose if they disagree.

---

# 15. FINAL HANDOFF SUMMARY

The repository is no longer just a mixed prototype.

Current direction:
- Ilaria = cognition/model
- Swyp = fast semantic systems language/compiler
- SwypikOS = effect authority + universal OS runtime
- Swypik native kernel = hardware authority seed

Swyp is already at 0.14 experimental with SSA, direct x64/ARM64 work, Turbo bytecode, persistent sub-ms Core workflows and packed x64 CFG.

SwypikOS has a measured low-resource baseline:
- steady Working Set around 20 MB on the tested Windows desktop
- idle CPU effectively 0% on phone profile
- full regression 45 packages green
- background work is now bounded/preemptible in the paths implemented

The immediate blocker/next promotion item is the latest packed x64 CFG spill machine-code increment in Swyp. Validate that first before expanding the compiler further.
