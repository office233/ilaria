# Swyp supervisor preflight milestone — 2026-09-30

## Scope and preservation

This milestone adds compilation/preflight and frozen Core IR consumption to the
existing safe interpreter and broker transport. It introduces no VM, model
dependency, guest filesystem/clock authority, grants or OS supervisor. Existing
dirty work was retained on `codex/nexus-supervisor-v1`; no files were staged,
committed, reset or cleaned. Pre-edit Swyp source/docs and the protocol helper
were backed up to `%TEMP%/nexus-swyp-supervisor-v1-20260930-215910`.

The workspace owner delegated shared plan helper ownership and exact helper
mirrors in the other products. The generated DTO/schema remains owned by that
owner. The root integration script was also explicitly delegated; it calls the
three actual public CLIs and creates only hermetic public test fixtures.

## Source changes

- `internal/coreir/execute_effects.go:81`: detached `EffectPreflight` and
  `Executable.PreflightEffects`, reusing supported-effect and unique-capability
  checks already used by `RunWithEffects`. It validates without instructions,
  fuel consumption, handler calls or ambient effects.
- `cmd/swyp/core_preflight.go:18`: `core-preflight --entry ENTRY [-o SNAPSHOT]
  SOURCE` compiles once and emits the generated version-1 `EffectPlan`. Snapshot
  bytes are compact canonical module JSON without a trailing newline; their
  SHA-256 is the plan hash. Canonical snapshots over 1 MiB and wire-incompatible
  entry/binding identities fail before publication. Publication uses the existing
  exclusive creation helper and preserves existing files.
- `cmd/swyp/core_broker.go`: `--ir` reads the existing bounded strict Core decoder,
  prepares an owned module and hashes canonical JSON. Source replacement/deletion
  after preflight cannot change execution of that snapshot. Direct source/IR
  invocation also validates reachable wire bindings before any instruction or
  request, preventing late encoding failure after an earlier valid effect.
- `cmd/swyp/main.go`: preflight command dispatch and broker snapshot usage.
- `protocol/effects/plan.go:19`: `ValidatePlan` shares request identity/hash rules,
  non-null collections, sorted unique supported effects, at most 128 bindings,
  declared-effect binding keys and logical capability names. Conservative
  declarations without bindings are valid. Map iteration is sorted for stable
  diagnostics.
- `protocol/effects/plan.go:52`: `DecodePlan` reuses the strict 2 MiB envelope
  decoder and adds duplicate nested binding-key detection, including escaped
  aliases. Null, unknown, omitted, duplicate, malformed and trailing data fail.
- `protocol/effects/protocol.go:255`: shared private hash predicate extracted
  without changing the frozen request/result hash encoding.
- Exact `protocol.go` and `plan.go` mirrors in
  `ilaria/generated/swypeffects/` and `swypik-os/generated/swypeffects/`. All three
  packages remain named `effects`, matching their untouched generated DTOs.
- `internal/coreir/effect_preflight_test.go`: 2 top-level regression tests for
  detached transitive bindings, no trap execution, unsupported/ambiguous profiles,
  unknown entries and nil executables.
- `cmd/swyp/core_preflight_test.go`: 9 top-level regression tests for canonical
  snapshot/hash equality, replaced/deleted source, pure non-executing preflight,
  refusal before publication, preserved existing destinations, oversized canonical
  exports, wire identities, strict malformed snapshots and formatting-independent
  semantic hashes with exact large integers, and zero-request/zero-step direct
  broker refusal for an incompatible effectful callee after an earlier effect.
- `protocol/effects/plan_test.go`: 3 top-level regression tests with nested
  mutation cases for identities/effects/maps, pure/conservative plans, strict
  envelope/nested aliases, null/UTF-8/surrogate/trailing/ceiling rejection.
- `README.md` and `docs/BROKER_EXECUTION.md`: actual commands, hashes, plan schema,
  preflight API, supported limits and private snapshot protection responsibility.
- Workspace `scripts/verify-supervisor.py`: real three-CLI positive/refusal and
  persistent service integration, public signing test vector, bounded framing,
  read-only CK fixture journal inspection and actual-process idle CPU counters.

## Gates and evidence

- Final Windows Go 1.21.13: full `go vet ./...` and
  `go test -count=1 ./...` passed all 14 packages: 725 top-level passes, 37 existing
  platform/toolchain skips, zero failures. Both generated helper mirror packages
  also passed their focused vet/build test gates.
- Native Linux Go 1.26.2 + GCC 15.2: full vet and all-package race tests passed
  before the last plan-helper/wire identity guard changes; CLI took 128.803 s.
  Latest affected protocol and Core race packages passed. Two latest full CLI
  race attempts hit only the existing fresh-executable test's 60 s nested Go-build
  deadline under mounted-toolchain host I/O contention (163.378 s and 171.441 s
  package totals). Its isolated exact race retry passed in 23.886 s; the second
  full attempt passed all 207 other top-level tests and reported 38 skips. A
  separate remainder run then reached its 300 s package deadline inside another
  existing synthesis Go subprocess during host contention. Focused latest broker
  race tests check the direct wire guard separately. These failed full attempts
  are not represented as a clean final all-package command.
- Final native Linux Go 1.26.2 + GCC 15.2: full vet passed and the unchanged full
  `go test -race -count=1 -timeout=180s ./...` passed all 14 packages using the
  public Go toolchain on the native Linux filesystem and
  `GOFLAGS=-buildvcs=false`. This metadata-only environment setting also applies
  to legacy nested Go builds; it removes aggregate mounted-checkout Git stamping
  without changing compilation, test assertions or 60 s/180 s time limits.
  This final run had 672 top-level passes, 40 skips and zero failures; CLI passed
  in 14.832 s. An earlier native-toolchain attempt with default VCS
  stamping still hit the fresh-build limit; that failed attempt is retained.
- Developer CLI rebuilt with `scripts/build-local.ps1`; the old executable was
  preserved. Final record: `agent-lab/build-20260930-231139-e10ebc/build.json`.
- Actual rebuilt CLI with PATH empty preflighted a pure function, verified the
  snapshot file hash, deleted the source and executed the pinned IR to return
  next(9007199254740993) = 9007199254740994 exactly, without a model or toolchain.
  The final native Linux CLI build passed the same deleted-source/PATH-empty
  canonical-snapshot execution smoke.
- Windows actual three-CLI supervisor gate passed scoped repeated `fs.read` plus
  `clock.read`, independent verifier evidence, CK PASSED/COMMITTED records,
  replay/policy refusal, cumulative read reservation, missing scope, rejected
  trust key and expected final-value hash acceptance/refusal. The persistent
  service exercised ready/signals/budgets/status/two runs/shutdown, reused its
  verifier and returned status with deleted source and zero child starts.
- One successful Windows plan measured host CPU 46.875 ms / peak RSS 9,498,624 B,
  Swyp CPU 31.25 ms / peak RSS 7,749,632 B, verifier CPU 15.625 ms / peak RSS
  5,791,744 B, 3 child process starts and 349.3051 ms plan wall time. The Swyp
  metric combines compilation/execution CPU and reports their maximum peak RSS;
  these are kernel process measurements from one fixture, not a RAM limit proof
  or a workload benchmark. The integration runner prints the actual run metrics.
- Read-only Windows idle measurement: supervisor PID 17628 and verifier PID 18628
  each added 0 ns to their kernel CPU counters over 2.015 s. This measures one
  local idle window at OS counter resolution; it is not an energy measurement,
  battery-life estimate, utilization forecast or cross-hardware performance claim.
- The same actual three-CLI supervisor gate passed on Linux. Its successful
  fixture measured host CPU 10 ms / peak RSS 7,192,576 B, Swyp CPU 14.545 ms /
  peak RSS 9,965,568 B, verifier CPU 0 at the process counter tick resolution /
  peak RSS 3,407,872 B, 3 starts and 34.329913 ms plan wall time. Linux idle PIDs
  136434/136456 each added 0 ns over 2.002304883 s. The runner inspects child
  processes across all Go OS threads; checking only the leader's child list had
  missed the live verifier and was corrected after an initial measurement-helper
  failure. Product execution/refusal cases passed in that earlier attempt too.
- `git diff --check` passed. Raw logs stay in the temporary audit backup directory.

## Actual limits and priorities

The supported execution subset remains `clock.read` and read-only `fs.read`
together with existing pure Core instructions and calls. Preflight reports the
entry's transitive declared effects and reachable actual instruction bindings;
it grants no authority and does not prove runtime path success. Host authority,
scope/path confinement, receipts, durable admission/commit, resource budgets,
independent evidence verification and recovery belong to SwypikOS/Ilaria.

Snapshot protection remains a host responsibility. Native broker transport,
write/network/process effects, ambiguous same-effect capability selection in one
function, externally serializable continuations and broad sandbox guarantees
are not implemented. Prioritize explicit requirement binding, recovery-aware new
effect contracts and measured cross-hardware service/resource tests. Preserve
the existing interpreter and stable protocol instead of adding parallel runtimes.
