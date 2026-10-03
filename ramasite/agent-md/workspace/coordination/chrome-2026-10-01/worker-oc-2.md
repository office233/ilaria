# Worker OC2 — native driver-image Go/C differential conformance

State: COMPLETE

## Ownership / workspace

- Worktree: `E:\nexus-worktrees\opencode-driver-conformance`
- Branch: `codex/opencode-driver-conformance`
- MCP/Bridge access verified.
- Root and SwypikOS `AGENTS.md` plus OC2 scope from
  `E:\nexus\docs\coordination\chrome-2026-10-01\opencode-batch-1.json`
  were read before edits.
- Existing worktree snapshot and `.nexus-opencode-baseline.json` were preserved.
- Root coordination later supplied the repository's five public tracked TTF
  assets plus `OFL.txt` under `swypik-os/ui/engine/fonts/`, with provenance and
  SHA-256 values recorded in
  `E:\nexus\docs\coordination\chrome-2026-10-01\opencode-public-assets.json`.
  Those inherited assets are not OC2 changes and were not modified or replaced.
- The original OC2 browser execution performed no reset/clean/stage/commit/push/deploy/publication, install, provider/config,
  secret/private-data/corpus/weight/binary inspection, subagent, or main-worktree
  edit was performed.

## Exact exclusive writes

Only these NEW files were written:

- `scripts/native-driver-image/go_probe/main.go`
- `scripts/native-driver-image/c_probe.c`
- `scripts/verify-native-driver-image.py`
- `swypik-os/docs/audit/native-driver-image-conformance.md`
- `docs/coordination/chrome-2026-10-01/worker-oc-2.md`

No production parser/header was modified.

## Real parser conformance delivered

The gate executes the two production parsers:

- Go: `core/devicesynth.ParseDriverImageV1`
- C: `swyp_x86_driver_image_parse` from the actual
  `kernel/src/arch/x86_64/driver_image.c`

The Go probe imports the public production package. The C probe is linked with
the production C source. Its two stubs satisfy only loader-only external symbols;
the parser itself is not copied or simulated.

For every input, the same bytes are passed to both probes. The gate compares:

- accept/reject;
- `entry_rva`;
- `image_span`;
- segment count;
- `total_pages`;
- each segment's virtual offset, file offset, file size, memory size, flags.

C-specific status classes and Go error strings are diagnostic only because they
are not a shared typed contract.

## Corpus / coverage

Final deterministic corpus: **77 cases, 6 valid, 71 reject**, fixed seed
`0x5a17`.

Covered:

- valid single and multi-segment images with distinct values in every common field;
- touching segment boundaries;
- entry at final executable byte;
- exact image-span maximum;
- exact 256-page cap and +1;
- exact 8-segment cap and +1;
- structural truncations at/immediately before header, descriptor, metadata and
  payload boundaries;
- magic/version/header/count failures;
- every header reserved field and flags;
- zero/unaligned/over-max span and entry bounds;
- segment reserved field;
- zero/unaligned/out-of-span memory;
- file-size > memory;
- huge file-offset/range overflow;
- metadata overlap;
- missing READ, unknown flag bits, W^X;
- overlapping virtual segments;
- entry in non-executable segment.

No driver loading/execution, hardware, MMIO/DMA/IRQ, boot or privilege is used.

## Bounded runner behavior

- build timeout: 60 s;
- probe timeout: 5 s;
- build capture: max 64 KiB per stdout/stderr stream;
- probe capture: max 16 KiB per stdout/stderr stream;
- build/corpus only in task-owned temp directory;
- Go build uses process-local `GOWORK=off`, `GOTOOLCHAIN=local`,
  `-buildvcs=false`, private `GOCACHE` and `GOTMPDIR`;
- pipe capture enforces the cap during collection; no unbounded output temp files;
- Windows gated child assignment to a kill-on-close Job Object; POSIX owned
  session/process group; timeout, overflow and normal exit reap residual children;
- divergence exits nonzero and preserves exactly the failing binary input,
  compact Go/C JSON and repro note in a separate four-file directory;
- every outcome deletes owned build/cache/temp outputs with containment checks;
- Windows quoted/unquoted `CC` preserves arguments through native parsing;
  explicitly missing configured executables fail without fallback;
- missing compiler exits 2 with `UNAVAILABLE`, never false PASS.

## Actual differential result

First Windows run without an available C compiler correctly returned exit 2:

```text
UNAVAILABLE native-driver-image conformance:
C compiler unavailable (tried CC, clang, gcc, cc, cl, zig cc)
```

An already-existing workspace Zig compiler was then supplied explicitly only
to the runner process:

```powershell
$env:SWYPIK_ZIG='E:\nexus\.tools\zig-0.16.0\zig.exe'
python -m py_compile scripts\verify-native-driver-image.py
python scripts\verify-native-driver-image.py
```

Final result, exit 0:

```text
PASS native-driver-image differential cases=77 valid=6 reject=71 seed=0x5a17
go=go-probe.exe c=c-probe.exe
compiler=E:\nexus\.tools\zig-0.16.0\zig.exe cc
```

Observed tools:

- Go 1.27.1 windows/amd64
- Zig 0.16.0
- Python 3.12.10

**No production Go/C parser divergence was found by this corpus.**

## Verification

### Focused affected product

With worker-private Go cache/temp and process-local Go env:

```powershell
go vet ./core/devicesynth
go test -count=1 ./core/devicesynth
```

PASS, including:

```text
ok  swypik-os/core/devicesynth  0.778s
```

### Required full SwypikOS gates — PASS after root asset restoration

The original public-source-only worktree omitted the tracked embedded fonts and
therefore could not complete the full gate. Root coordination resolved that
snapshot issue by copying the real public tracked assets bit-for-bit into the
worktree; their provenance/hashes are recorded in `opencode-public-assets.json`.
OC2 did not write or modify those assets and did not edit UI code.

After that external restoration, only the previously blocked full gate was
rerun, with task-private Go cache/temp directories and process-local
`GOWORK=off`, `GOTOOLCHAIN=local`, and `GOFLAGS=-buildvcs=false`:

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```

Combined job `jdakad9636` — **PASS, exit 0**, 58.2 s.

- `go vet ./...` completed successfully with no diagnostics.
- `go test -count=1 -timeout 180s ./...` reported **52 Go packages OK,
  0 failed**.
- `swypik-os/ui/engine` now passed (`0.766s`).
- `swypik-os/core/devicesynth` remained covered by the full product gate.

### File checks

Bridge `check_files`:

- Go probe: no gofmt diagnostics.
- Python runner: AST valid.

The C probe compiled and linked with the production parser as part of the
successful differential gate.

### Git

`git diff --check` — exit 0.

Git emitted only pre-existing CRLF->LF warnings for:

- `swypik-os/README.md`
- `swypik-os/docs/UNIVERSAL_NATIVE.md`
- `swypik-os/docs/WINDOWS_DESKTOP.md`

Final scoped status contains exactly the five OC2 files above as new/untracked.
Branch remains `codex/opencode-driver-conformance`.

## Completion state

OC2 is COMPLETE: the real Go/C differential gate is passing and the required
full SwypikOS vet/test gate is now also passing after the coordinator restored
the inherited public font assets. No production parser defect was found.

## Handoff

The five OC2 files are released for review/integration and are frozen after the
final `git diff --check`. Do not patch either production parser based on this
run; there is no observed Go/C divergence to fix. Integration into Main remains
the coordinator/integrator's responsibility and was not performed by the OC2
browser worker.

## Root-authorized review remediation — 2026-10-01

The browser worker is terminal and its files were explicitly handed over to
`audit_swyp` in the same dedicated worktree. Root authorized changes only to
`scripts/verify-native-driver-image.py` and the two OC2 reports. Neither probe,
the corpus/oracle, nor production parser/header was changed.

Independent review identified four runner defects: quoted Windows executable
paths in `CC` were rejected; capture was checked only after unbounded output
files had been written; timeout killed only the direct process; and divergence
kept the whole Go build/cache directory. The runner now enforces the behavior
documented above, using only standard-library/native host facilities.

Actual remediation checks:

- Windows: **9 synthetic utility checks PASS**, including quoted/unquoted
  existing Zig with argument preservation and real `cc --version`, missing
  configured compiler, exact/overflow bounds on both streams, child/grandchild
  cleanup at timeout and normal parent exit, and four-file-only failure retention.
- WSL/POSIX: **7 synthetic utility checks PASS** for argument preservation,
  exact/overflow bounds, both process-group cleanup paths, and minimal retention.
  Argument preservation used the existing Python executable; this is not a
  claimed Linux C conformance run or a sandbox for detached malicious processes.
- Repaired worktree real Go/C conformance with quoted
  `CC='"E:\nexus\.tools\zig-0.16.0\zig.exe" cc'`: **PASS, exit 0,
  77 cases / 6 valid / 71 reject**.
- Python AST and scoped `git diff --check`: **PASS**.

The earlier 52-package full OS vet/test PASS remains valid unchanged-production
evidence and was not repeated.

### Final integration — PASS

- All **443 public OS baseline files** matched Main and the dedicated worktree;
  both probe hashes were unchanged. All five destinations were absent before
  integration; current coordinator claims were disjoint.
- Exact five-file integration into `E:\nexus`, branch
  `codex/nexus-supervisor-v3`, used guarded containment and exclusive creation;
  all copied file hashes matched the tested worktree.
- One independent Main real Go/C conformance run with the already-existing
  `E:\nexus\.tools\zig-0.16.0\zig.exe` via `SWYPIK_ZIG`: **PASS,
  77 cases / 6 valid / 71 reject, exit 0**.
- Main `git diff --check`: **PASS**; only the already-recorded unrelated
  CRLF-to-LF warnings appeared. Final versions of these two reports were
  reconciled byte-for-byte between the worktree and Main.
- No parser/source change outside the five claims, staging, commit, push,
  installation, new model/browser job, or private-data access was performed.

The OC2 deliverable and its authorized runner remediation are COMPLETE and
released to root. Parser-only and POSIX process-group limits remain explicit in
the product audit document; this gate does not prove native device readiness.
