# OC3 native cleanup fault matrix

State: COMPLETE

## Exact exclusive claims
- `swypik-os/kernel/tests/native_cleanup_fault_test.c`
- `scripts/verify-native-cleanup.py`
- `swypik-os/docs/audit/native-cleanup-fault-matrix.md`
- `docs/coordination/chrome-2026-10-01/worker-oc-3.md`
- `swypik-os/kernel/src/core/device_platform.c` (first exclusive production extension authorized by root)
- `swypik-os/kernel/src/core/device_broker.c` (second exclusive production extension authorized by root)

## Checkpoint 1 — scope and contracts
- Allocated worktree: `E:\nexus-worktrees\opencode-cleanup-matrix`; branch: `codex/opencode-cleanup-matrix`.
- Read root and SwypikOS AGENTS.md; no nested kernel/docs/scripts instructions found.
- All four claimed paths absent before creation. Existing modified/deleted/untracked snapshot preserved.
- Read real broker/platform implementations, headers, domain implementation and host fake-ops pattern. No production edits authorized.
- Tests will link real broker/platform/domain/capability/graph code; fake callbacks only model resource effects and inject errors.
- Windows PATH has Python/Go but no C compiler. Initial WSL compiler probe exit 1; availability investigation is limited to installed compiler commands/standard locations.

## Checkpoint 2 — implementation and gates
- Added host C matrix linking only real broker/platform/domain/capability/graph implementations. 55 intended fixtures cover MMIO, IRQ, DMA, first/second occurrence injection, ordinary cleanup, mixed revoke, rollback double faults, retry, stale handles, wrong fences, quiesced grants and unaffected device.
- Added Python runner with strict compile, bounded output, timeouts, owned temporary outputs/caches, exact fixture repro and unavailable/nonzero semantics. No production or other-test changes.
- Windows and Ubuntu WSL installed-compiler command/standard-location probes found none. Native compiler gate is UNAVAILABLE, not PASS.
- Rollback source candidates are documented with lines and callback sequence in `swypik-os/docs/audit/native-cleanup-fault-matrix.md`. They are not claimed as executed defects. Safety expectations remain unchanged. `rollback-p2` is a masked-state control, not an alleged production defect.

## Checkpoint 3 — actual verification
| Command | Actual result |
| --- | --- |
| `python scripts/verify-native-cleanup.py` | Windows fallback executed existing WSL Python; child UNAVAILABLE exit 2, shell tool wrapper exit 1; native compile/run NOT RUN |
| `go vet ./...` from `swypik-os` | exit 1: `ui/engine/fonts_windows.go:14:12`, `fonts/*.ttf` unmatched |
| `go test -count=1 -timeout 180s ./...` from `swypik-os` | exit 1: same setup failure in `cmd/swypik-os`, `ui/engine`; other listed testable packages passed |
| `git diff --check` | exit 0; existing CRLF normalization warnings only |
| Python runner self-test via `python -B -` (AST parse/import, subprocess success, exit 7, 0.1s timeout, absent executable, 200KB output) | exit 0; expected subprocess codes 0/7/124/2, output truncated below 25KB |

Go commands used process-local `GOPROXY=off`, `GOTOOLCHAIN=local`, owned `GOCACHE`/`GOTMPDIR` in `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-go-a416abc8f3184186ad2e14cb30a77e24`. Go outputs are separate and retained; runner temp directories remove only their own outputs. No install, global settings, staging, commit, reset, clean, push, deploy, external messaging or agents.

## Previous handoff / requested scope decision
Previous State: BLOCKED

Only the four exclusive new files above were changed. Detailed fixture definitions,
invariants, source candidates and limits are in the audit matrix. Native C syntax
and execution remain unverified without an existing accessible compiler. No full
product PASS and no COMPLETE claim.

Coordinator: provide an existing compiler accessible in this worktree (or authorize
a different acceptance decision). Separately authorize scope extension/owner fixes
for missing Windows font embed inputs and, after executing `rollback-p0`, `p1`,
`p3`, `p4`, the production rollback candidates at `device_platform.c:119–123`,
`199–203`, `207–211`. No out-of-scope files were changed. Wait for scope extension;
do not auto-fix production or weaken invariants.

## Checkpoint 4 — authorized continuation
State: RUNNING

Same owner/worktree/branch and exactly the four original claims. Root supplied
existing compiler `E:\nexus\.tools\zig-0.16.0\zig.exe` for execution only, and
materialized public font assets as inherited inputs. No assets/binaries or external
coordination manifest read by OC3. Root/product instructions reread; no kernel AGENTS.

Conditional production extension names `swypik-os/kernel/src/arch/x86_64/device_platform.c`,
but that path does not exist: the real linked implementation is
`swypik-os/kernel/src/core/device_platform.c`. Native regression runs first; production
edits await confirmation of the actual path rather than assuming broader authority.

## Checkpoint 5 — real regression and full product gates
State: BLOCKED

- `python scripts/verify-native-cleanup.py --compiler E:\nexus\.tools\zig-0.16.0\zig.exe`:
  compilation exit 0, execution exit 1; **55 cases / 12,345 checks / 7 failures**.
- Native findings (real unchanged `src/core/device_platform.c`):
  - `rollback-p0`, lines 119–123: query,reserve,map!,release!;
    public revoke returns OK but VA reservation persists (va=1,map=0).
  - `rollback-p1`, lines 199–203: alloc_irq,bind!,release_irq!;
    public revoke returns OK but IRQ vector persists (vec=1,bound=0).
  - `rollback-p3`, lines 205–211: alloc_irq,bind,unmask!,mask,unbind!,release_irq;
    release occurs while bound; vector is freed while binding persists;
    public revoke cannot recover it (vec=0,bound=1). Four assertions fail.
  - `rollback-p4`, lines 205–211: alloc_irq,bind,unmask!,mask,unbind,release_irq!;
    public revoke returns OK but IRQ vector persists (vec=1,bound=0).
- All other fixtures pass, including `rollback-p2`. No fixture/invariant changes
  were made to obtain a PASS. Repro: same runner/compiler with `--case rollback-p0`
  (or `p1`, `p3`, `p4`). Full run emitted each exact callback trace and resource ledger.
- Full product `go vet ./...`: exit 0; `go test -count=1 -timeout 180s ./...`:
  exit 0. Windows font setup is now resolved; all testable packages pass.
- Final resumed `git diff --check`: exit 0; claimed-file whitespace check exit 0.
  Existing CRLF normalization warnings only.
- Process-local Go outputs: `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-go-resume-420dea4fd3e04959b08d97d5ffc090bd`.
  `GOPROXY=off`, `GOTOOLCHAIN=local`; no installation/global settings.

## Current handoff and delta from baseline
Four original new-file claims unchanged. In this continuation only the two reports
were updated; C test and runner compiled/executed unchanged. Inherited public fonts
are root work, not OC3 edits. No production files changed, no other test changed.

Operational blockers resolved; production failures now demonstrated, not candidates.
Remaining blocker: root authorized `src/arch/x86_64/device_platform.c`, nonexistent;
actual defects are in `src/core/device_platform.c`. Request root confirmation of
that exact production extension. Do not duplicate the implementation under arch.
No COMPLETE claim while native gate fails. Hardware/partial callback effects,
physical backing allocators and corrupt-success backend responses remain unproved.

## Checkpoint 6 — corrected production scope, feasibility blocker
State: RUNNING

Root explicitly corrected the production extension to `src/core/device_platform.c`.
Root/product AGENTS reread; no nested kernel AGENTS. Same owner/worktree/branch.
No architecture duplicate created. Before editing production, verified the actual
public retry path and the unchanged regression assertions:

1. Broker acquisition returns immediately on backend failure without publishing a
   record (`device_broker.c:175–178`, `248–251`). Failed rollback therefore cannot
   be associated with a broker cleanup handle merely by retaining a platform record.
2. Broker revoke only visits its own active records and then revokes the domain
   (`device_broker.c:589–609`). There is no platform domain-cleanup callback in
   `SwypDeviceBrokerOps`, no broker pointer in `SwypDevicePlatform`, and no call to
   the platform on revoke if no broker records exist. Thus core-only retention
   cannot make the existing `rollback-p0/p1/p3/p4` public revoke retry recover
   or propagate persistent rollback failure. Arbitrary immediate retry would only
   mask the fail-once fixture, not solve ownership/revocation safely.
3. Unchanged `rollback-p3` trace assertion (`native_cleanup_fault_test.c:337–338`)
   requires `release_irq` after injected `unbind!`, while the fake ledger correctly
   asserts release is forbidden while bound (`:111–112`). A safety-preserving fix
   must stop before release on unbind failure. The old exact trace is incompatible
   with that fix. Correcting it would strengthen safety, not weaken the invariant,
   but user explicitly requested no matrix alteration for PASS.

No production edit made: a partial retention-only change would leave failed revoke
claiming success with live resources. Await additional scope decision; do not bypass
broker authority, add global coupling, fake success or add bounded arbitrary retries.

## Checkpoint 7 — gates repeated; frozen handoff
State: BLOCKED

- Integral native matrix (same explicit Zig compiler): compile 0, run 1;
  55 cases, 12,345 checks, 7 failures, unchanged from pre-fix baseline.
- Individual `--case rollback-p0`: compile 0/run 1, 108 checks/1 failure.
- Individual `--case rollback-p1`: compile 0/run 1, 104 checks/1 failure.
- Individual `--case rollback-p3`: compile 0/run 1, 115 checks/4 failures.
- Combined shell invocation hit its outer 300s timeout while compiling p4;
  no result inferred. One separate bounded p4 invocation completed:
  compile 0/run 1, 115 checks/1 failure. No infinite retries.
- Full OS `go vet ./...`: exit 0; `go test -count=1 -timeout 180s ./...`: exit 0.
- Final `git diff --check`: exit 0; claimed-file whitespace verification: exit 0.
  Process-local owned Go outputs:
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-go-scope-fff30195a47c4350b1a60a3e5353c98a`.

Requested minimal additional scope: allow `src/core/device_broker.c` to retain
cleanup ownership for a nonzero backend cleanup token on failed acquisition
(without returning a usable public mapping/binding), alongside authorized platform
retention; then revoke can actually retry and propagate cleanup failures. This is
a proposed design, not an implementation or expanded claim. No header change is
assumed authorized or necessary. Also authorize a safety-correct regression trace:
`rollback-p3` must stop at `unbind!`, retain binding/vector, and release only after
a successful retry; persistent cleanup failure should remain quiesced/tracked.
The matrix's current exact failure trace was my test-design error: it hard-coded
the unsafe baseline order. The no-release-while-bound invariant itself is correct
and must remain. No test edited to hide failures.

Delta for this continuation: two reports updated, production/matrix/runner unchanged.
Five claims recorded (four original files plus authorized core platform), but no
production edit made. Handoff frozen before Main review; no integration or external
messages. Native gate still FAIL, not COMPLETE. Hardware/partial-effect/backing
limitations remain as documented in the audit matrix.

## Checkpoint 8 — six-file scope authorized
State: RUNNING

Root authorized broker cleanup ownership on failed acquisition and the exclusive
p3 trace correction, plus bounded persistent-error fixtures in the same test.
Exactly six claims above; no headers or other production files. Root/product
instructions reread; no nested kernel AGENTS. Plan: existing record reserved0 marks
cleanup-only ownership, denied by public handle/token lookup; revoke uses existing
cleanup dispatch. No usable public outputs, global authority or automatic retry.

## Checkpoint 9 — production delta and successful gates
State: RUNNING (native/OS gates passed; final diff check pending)

Actual delta from the received snapshot, restricted to six claims:
- New `native_cleanup_fault_test.c`: original 55 fixtures retained; sole authorized
  original trace correction p3 stops at unbind failure and asserts retained vector/
  binding. Four additional persistent rollback fixtures each fail two separate
  revoke attempts, assert no automatic retry, quiesced grants, hidden/guessed handle
  denial, wrong-fence rejection, other-device isolation and final safe cleanup.
- New `verify-native-cleanup.py`: real C compiler/runner, bounded output/deadlines,
  owned temporary outputs/caches; unchanged in this fix continuation.
- `device_platform.c`: retain MMIO reservation on failed rollback release; retain
  IRQ vector before bind, preserve binding/vector on unbind failure, release vector
  only after successful unbind. Return internal nonzero token only when resources
  remain; preserve original acquisition error and never return a usable mapping.
- `device_broker.c`: failed MMIO/IRQ/DMA acquisition with a nonzero backend token
  retains cleanup ownership in existing records, marked reserved0=1. Public record
  lookup and IRQ token/handle lookup reject those cleanup-only records. Existing
  revoke dispatch retries them, preserves/quiesces on failure, advances generation
  on successful release. No headers, ABI structs or other production files changed.
- Two reports document exact baseline failures, scope authorization and evidence.

Commands after actual production edits:
- **One integral native invocation only**:
  `python scripts/verify-native-cleanup.py --compiler E:\nexus\.tools\zig-0.16.0\zig.exe`.
  Compile exit **0**, run exit **0**: **59 cases, 13,550 checks, 0 failures**.
  Includes all four defect regressions; no separate recompilation of those cases.
  Baseline was 55 cases, 12,345 checks, 7 failures. No fail-once workaround.
- `go vet ./...` from `swypik-os`: exit **0**.
- `go test -count=1 -timeout 180s ./...` from `swypik-os`: exit **0**.
- Process-local Go outputs:
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-go-fixed-306318a19cf0461c90fbd80110c765a7`.
  Dependency network disabled, local toolchain, no install/global setting edits.

Limitations: fake faults occur before side effects; physical backing allocators,
hardware interrupt/IOMMU quiescence and concurrency are not proved. Corrupt-success
addresses/vectors/tokens and rollback mask failure with partial unmask effects are
outside demonstrated fixes. In particular existing ignored mask return at
`device_platform.c` unmask-error rollback remains inherited behavior (p2 initially
masked control passes); do not claim safety for partial unmask/mask failures.
Nonzero failure tokens from DMA callbacks are retained but partial DMA effect
fixtures are not supplied. No general audit, no additional fixes/claims.

## Final frozen handoff
State: COMPLETE

Final `git diff --check`: exit **0** (inherited CRLF warnings only); explicit
whitespace/newline verification of all six claimed files: exit **0**. Native and
full OS gates above passed after the final production/test edits; subsequent edits
only record results. Exactly six files delivered, no additional production/headers/
tests/assets edited. Snapshot and root materialized public assets preserved.

Frozen for Main review. No integration, staging, commit, push, deployment, external
messages, installations, global settings, other worktree edits or subagents.
COMPLETE means scoped host cleanup fixes and requested gates, not hardware safety
certification or remediation of excluded malformed/partial-effect cases.
