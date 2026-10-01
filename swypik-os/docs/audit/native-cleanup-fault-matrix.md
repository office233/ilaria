# Native cleanup fault matrix — OC3

State: COMPLETE (scoped host fix/gates passed; frozen for Main review, hardware limits remain).

## Final fix checkpoint — six authorized files

Root authorized both real core production files, p3 trace correction and bounded
persistent-error fixtures. Earlier BLOCKED sections below are historical evidence.

- `device_platform.c`: preserve reservation on failed MMIO rollback release;
  preserve IRQ vector/binding until successful teardown, stop before vector release
  on failed unbind. Nonzero internal cleanup token accompanies original acquisition
  error when resources remain. No public mapping/binding is returned on failure.
- `device_broker.c`: retain cleanup-only ownership for nonzero failed-acquisition
  tokens (MMIO/IRQ/DMA) in existing records using reserved0. Public lookup/IRQ
  token/handle reverse lookup deny these records. Existing revoke dispatch safely
  retries, preserves records and quiescence on failure, releases/stales on success.
  No global authority, header/ABI structure changes or duplicate recovery code.
- Same test: keep 55 fixtures; correct only unsafe p3 exact trace to stop at
  `unbind!`, with retained vector/binding assertions; add four persistent fixtures
  exercising two failed revoke attempts and final success, no auto retry, hidden
  handle denial, wrong fences, denied grants and unaffected-device isolation.
- Runner unchanged; two reports updated. Public fonts/compiler remain inherited.

Exactly one integral native compile/run after the production change:
`python scripts/verify-native-cleanup.py --compiler E:\nexus\.tools\zig-0.16.0\zig.exe`:
compile **0**, run **0**, **59 cases / 13,550 checks / 0 failures**. All four defect
cases included, not separately recompiled. Baseline: 55/12,345/7 failures.
Full OS `go vet ./...` and `go test -count=1 -timeout 180s ./...`: exit **0**.
Final `git diff --check` and explicit six-claim whitespace check: exit **0**.
Handoff frozen; no Main integration, stage/commit/push/deploy or extra assets.

Known coverage limits remain: no real hardware, boot, allocator backing, concurrent
callbacks or partial callback side effects. Existing mask-return handling on failed
IRQ unmask is unchanged: p2 assumes initially masked, pre-effect failures; no claim
for partially successful unmask followed by failed mask. Malformed-success backend
outputs and partial DMA runtime effects remain outside this fix/test coverage.

## Current frozen handoff — corrected scope

Root now explicitly authorizes only `src/core/device_platform.c` in addition to the
four original files. No production change was made: the unchanged broker returns
on acquisition error before recording cleanup ownership (`device_broker.c:175–178`,
`248–251`), and revoke visits only broker records (`:589–609`). A platform-only
retained orphan is never called by public revoke. Immediate fail-once retries
would merely mask these fixtures and cannot guarantee persistent-error recovery.

The matrix has a test-design error at `native_cleanup_fault_test.c:337–338`:
the exact p3 trace requires release after failed unbind, contradicting its correct
no-release-while-bound invariant (`:111–112`). A proper fix must stop that trace at
unbind failure and assert retained vector/binding, then release after successful
retry. That correction needs explicit permission given the unchanged-matrix request;
no expectation was weakened or silently changed.

Request additional exclusive `src/core/device_broker.c` scope for failed-acquisition
cleanup token ownership and explicit permission to correct the unsafe trace while
strengthening persistent-failure/retention assertions. Do not duplicate authority
inside platform or introduce global coupling. This is a proposal, not an edit/claim.

Latest repeated gates: native integral compile 0/run 1 (55 cases, 12,345 checks,
7 failures). Isolated p0/p1/p3/p4 each compile 0/run 1, respectively
108/104/115/115 checks and 1/1/4/1 failures. Combined command's outer 300s deadline
interrupted its p4 compile; one separate bounded p4 run completed, no result
inferred from interruption. Full OS vet/test and final diff/whitespace checks exit 0. Production and matrix
remain identical to pre-fix baseline; this continuation only updates reports.

Older scope-path blockers below are historical and superseded by this section.

## Latest checkpoint — resumed execution, 2026-10-01

Root supplied existing Zig `E:\nexus\.tools\zig-0.16.0\zig.exe` and inherited
public font assets. No compiler installed and no asset content read/edited by OC3.

- `python scripts/verify-native-cleanup.py --compiler E:\nexus\.tools\zig-0.16.0\zig.exe`:
  real C compile exit **0**; real matrix execution exit **1**;
  **55 cases, 12,345 checks, 7 failures**. No native PASS.
- Confirmed failures: `rollback-p0` leaves VA reserved; `rollback-p1` and `p4`
  leave IRQ vectors allocated; `rollback-p3` calls release vector while still
  bound, then public revoke leaves the binding orphaned. Exact callback traces
  and source locations are in the table below. All other fixtures passed,
  including the `p2` masked-state control. Assertions were not weakened.
- Full `go vet ./...` and `go test -count=1 -timeout 180s ./...` from `swypik-os`:
  both exit **0**, including Windows engine/command packages. Prior font blocker
  is resolved by inherited assets, not OC3 changes.
- Resumed `git diff --check` and claimed-file whitespace verification: exit **0**.
- Production fix blocked by explicit path mismatch: root's conditional extension
  names `kernel/src/arch/x86_64/device_platform.c`, which does not exist. Actual
  implementation linked by runner is `kernel/src/core/device_platform.c`.
  Await root confirmation of that exact path; no production files edited.

Earlier unavailable results below are historical, superseded by this checkpoint.

## Scope and real implementation

The host test links `device_broker.c`, `device_platform.c`, `driver_domain.c`,
`capability.c`, and `device_graph.c` directly. It calls public broker APIs through
the real platform adapter. Fake address-space, interrupt-controller and runtime
callbacks record effects only: no duplicate validator, capability resolver,
revocation or recovery algorithm. Two real domains/devices use disjoint resources.

Run from the workspace: `python scripts/verify-native-cleanup.py`.
Existing gcc/clang/zig/MSVC may be selected with `--compiler <executable>`.
Windows without a compiler tries existing WSL Python once, never installs anything.
Reproduce one fixture: `python scripts/verify-native-cleanup.py --case rollback-p0`.
Unknown fixtures and missing compilers exit 2, invariant failures exit 1,
timeouts exit 124. Compilation uses C11 and warnings as errors. Compilation/run
deadlines default to 90/20 seconds; output retention is capped at 24,000 bytes per
process and continuously drained. Each invocation owns a separate temporary
directory for executable, compiler temporary files and Zig caches; no kernel `out/`
or repository cache is used. CLI flags allow existing temp parent and shorter
deadlines. No hardware, native boot, administrator privileges or tool installation.

## Contract-derived invariants

- Broker outputs are unpublished/zero on failed acquisition; records publish only
  on success (`device_broker.c:175–195,248–267,411–435`).
- MMIO releases virtual reservation only after successful unmap. A failed unmap
  preserves mapping and reservation; a failed release preserves reservation but
  does not repeat unmap (`device_platform.c:146–163`). This is virtual reservation
  safety, not proof about physical page allocator backing: that allocator is not
  exposed by these APIs.
- IRQ cleanup masks before unbind before vector release. Failed unbind retains
  binding/vector; failed release retains vector but must not repeat unbind
  (`device_platform.c:250–266`). No released vector may remain controller-bound.
- DMA map/unmap is delegated to one runtime callback (`device_platform.c:270–287`);
  failure before effects retains the prior DMA resource state. Actual IOMMU page
  allocation/backing and partial effects are not exposed here and are not claimed.
- Revocation quiesces first, visits active records in broker slot order, continues
  after callback errors, retains failed records, and revokes grants only after
  complete cleanup (`device_broker.c:589–609`). Domain resolve denies all grants
  while quiesced (`driver_domain.c:296–300`). Successful cleanup stales handles
  through generation increments; capability revoke stales grants.
- Wrong fences cause no callbacks; old broker handles stay stale after slot reuse.
  The other device keeps all resources/records and remains operational after a
  target-device cleanup error or success. Retry uses public APIs, never test repair.

## Deterministic fixtures (55 cases compiled/run in latest checkpoint)

| Family | Injection and exact order | Checks |
| --- | --- | --- |
| `acquire-k0-n0..3` | query → reserve → map; map failure → release | Success, each failure prefix, zero outputs, exact ledger, acquisition retry |
| `acquire-k1-n0..3` | allocate vector → bind → unmask; bind failure → release vector; unmask failure → mask → unbind → release vector | Same; IRQ ordering/vector safety |
| `acquire-k2-n0..1` | DMA map callback | Same; mapped DMA remains tracked |
| `dispose-k0-n0..2`, `revoke-k0-n0..2` | unmap → release | Each cleanup failure, retained stage state, retry skips completed unmap |
| `dispose-k1-n0..3`, `revoke-k1-n0..3` | mask → unbind → release vector | Each failure, retained vector/binding, retry skips completed unbind |
| `dispose-k2-n0..1`, `revoke-k2-n0..1` | DMA unmap | Failure and retry, stale handle |
| `mixed-revoke-n0..6` | MMIO unmap/release → IRQ mask/unbind/release → DMA unmap (interleaved other-device slots ignored) | Exact continuation after each error, one survivor, quiesce/deny, only survivor retries |
| `nth2-acquire-k*-step*`, `nth2-cleanup-k*-step*` | Fail second occurrence of every allocation/map/unmap/release callback | Per-operation counters, first device unchanged, second device retry |
| `generation-and-fence-reuse` | Release/reacquire each resource kind | Generation changes, old handle stale, wrong fence denied, no callback side effects |
| `irq-ack-faults` | EOI → unmask, either callback fails | Exact prefix, binding retained, successful retry |
| `rollback-p0..4` | Primary acquisition error plus a failing rollback callback | Exact trace, no freed-bound vector, public revoke retry leaves no orphan |

## Production findings — native-confirmed; require corrected scope extension

`rollback-p0`, `p1`, `p3`, `p4` are executed findings from the latest checkpoint.
Expectations remain safety invariants: they are not weakened to accept an orphan
or freed-bound vector. `p2` is a passing control.

| Fixture | Callback sequence ( ! = injected failure ) | Source and suspected defect |
| --- | --- | --- |
| `rollback-p0` | query,reserve,map!,release!; public revoke | `device_platform.c:119–123`: failed rollback release ignored; no platform/broker record owns surviving reservation |
| `rollback-p1` | alloc_irq,bind!,release_irq!; public revoke | `device_platform.c:199–203`: vector leak has no published cleanup record |
| `rollback-p2` | alloc_irq,bind,unmask!,mask!,unbind,release_irq | Control fixture, not a defect claim: fake unmask fails before effects, so the initially masked controller remains masked despite rollback mask failure |
| `rollback-p3` | alloc_irq,bind,unmask!,mask,unbind!,release_irq | `device_platform.c:207–210`: vector release despite live binding; no retry owner |
| `rollback-p4` | alloc_irq,bind,unmask!,mask,unbind,release_irq!; public revoke | `device_platform.c:209–211`: vector release failure ignored; no retry owner |

Production authorization names a nonexistent architecture path. Coordinator must
confirm the actual `src/core/device_platform.c` extension before fixes; compiler
availability is now resolved. Broker malformed-success token/address rollback also ignores cleanup
errors (`device_broker.c:180–184,253–257,417–421`); corrupt-success callback fixtures
are **not covered**, and no claim is made for those cases.

## Historical first-pass gates (superseded by latest checkpoint)

- Windows/Ubuntu WSL compiler probes: no `cc/gcc/clang/zig/cl` found in PATH or
  checked standard locations. `python scripts/verify-native-cleanup.py`: WSL child
  explicitly reports UNAVAILABLE/exit 2; PowerShell tool wrapper reports exit 1.
  Native compile/run **not performed**, no PASS or executed defect claim.
- From `swypik-os`, `go vet ./...`: exit 1.
- From `swypik-os`, `go test -count=1 -timeout 180s ./...`: exit 1.
  Both blocked by `ui/engine/fonts_windows.go:14:12: pattern fonts/*.ttf: no matching
  files found`. `cmd/swypik-os` and `ui/engine` fail setup; all other listed testable
  packages passed. Font content was not read, fetched or modified.
- Go environment was process-local: `GOPROXY=off`, `GOTOOLCHAIN=local`, separate
  `GOCACHE`/`GOTMPDIR` under approved temporary parent. No dependency installation.
- `git diff --check`: exit 0 (existing CRLF normalization warnings only).
- Runner-only Python self-test: exit 0. AST syntax/import, success, exit 7, timeout
  (124), unavailable executable (2), and 200KB output bounded below 25KB verified.
  This is **not** a C compilation or matrix PASS.

Runner timeout kills/waits its direct process. WSL fallback relies on the inner
runner's compiler/run deadlines; an outer WSL termination is not a guaranteed
kill of every possible compiler descendant. Fake errors occur before effects;
partial-success callback behavior, real hardware quiescence, physical backing
allocators and malformed-success backend outputs are outside demonstrated coverage.

Final status cannot be COMPLETE while the native matrix fails and the exact
production fix path remains unconfirmed. No baseline production changes made.
