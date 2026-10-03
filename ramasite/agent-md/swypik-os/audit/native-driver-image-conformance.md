# Native driver-image Go/C differential conformance

Date: 2026-10-01  
Worktree: `E:\nexus-worktrees\opencode-driver-conformance`  
Branch: `codex/opencode-driver-conformance`

## Scope

This gate compares the two existing production parsers for the same x86_64
driver-image v1 bytes:

- Go: `core/devicesynth.ParseDriverImageV1`.
- C: `swyp_x86_driver_image_parse` from
  `kernel/src/arch/x86_64/driver_image.c` with its real public header.

The probes do not copy either validator. The Go probe imports the public
`swypik-os/core/devicesynth` package. The C probe is compiled together with
the production `driver_image.c`; two link-only stubs satisfy loader-only
dependencies that the parser does not call.

No driver is loaded or executed. No hardware, kernel privilege, DMA/MMIO/IRQ,
boot path, or device state is touched.

## Compared observable contract

For every input, the gate compares acceptance versus rejection.

For accepted inputs it also compares every common observable parsed field:

- `entry_rva`
- `image_span`
- segment count
- `total_pages`
- every segment's `virtual_offset`, `file_offset`, `file_size`,
  `memory_size`, and `flags`

C-specific `SwypStatus` rejection classes and Go error strings are retained
only as diagnostic output; they are not falsely treated as a shared error-code
contract.

## Deterministic corpus

The corpus is generated in memory by
`scripts/verify-native-driver-image.py` with fixed seed `0x5a17`.
The final run contained **77 cases: 6 valid, 71 reject**.

Coverage includes:

- canonical single-segment and multi-segment images with distinct values in all
  common output fields;
- valid touching segment boundaries, entry at the final executable byte,
  maximum image span, exact 256-page cap, and exact 8-segment cap;
- structural truncations at and immediately before header-field,
  descriptor-table, metadata, and payload boundaries;
- bad magic/version/header size/segment count;
- every header reserved field and header flags;
- zero, unaligned, and over-limit image spans plus entry-at/outside-span;
- segment reserved field, zero/unaligned memory size, virtual-range overflow,
  file-size > memory-size, huge file-offset/range overflow, and metadata overlap;
- missing READ, unknown flag bits, W+X, and no executable entry;
- overlapping virtual segments;
- entry inside a non-executable segment;
- page cap + 1.

The corpus is deliberately small; it is not fuzzing and does not claim
exhaustive coverage of arbitrary byte strings.

## Runner bounds and repro behavior

Both probe binaries receive the exact same case file.

The Python runner uses:

- build timeout: 60 seconds;
- per-probe timeout: 5 seconds;
- build-output capture limit: 64 KiB per stdout/stderr stream;
- probe-output capture limit: 16 KiB per stdout/stderr stream;
- task-owned temporary build/corpus directory;
- `GOWORK=off`, `GOTOOLCHAIN=local`, `-buildvcs=false`, and private
  `GOCACHE`/`GOTMPDIR` for the temporary Go probe build.

Capture reads directly from pipes into capped memory buffers; excess output
terminates the owned subprocess tree instead of first spooling unbounded files.
On Windows an anonymous kill-on-close Job Object owns a gated wrapper before it
can start the compiler/probe, so descendants cannot run before assignment. On
POSIX the command starts in its own session/process group. Timeout, overflow,
and normal parent exit all clean up residual processes in that owned tree/group.
Failure to establish Windows ownership fails closed.

A divergence exits nonzero and preserves exactly four files in a separate
task-owned repro directory: the failing binary input, `go.json`, `c.json`, and
`README.txt`. Every outcome removes the owned build/corpus directory, including
`GOCACHE` and `GOTMPDIR`; compiler outputs/caches are not retained as a repro.
Cleanup checks the resolved temporary-root containment before recursive removal.

Windows `CC` uses `CommandLineToArgvW` for quoted/unquoted executable paths and
arguments. An explicitly configured missing executable fails; it does not fall
back to an unrelated compiler. `SWYPIK_ZIG` remains the explicit higher-priority
override, and POSIX `CC` keeps shell-style argument parsing without using a shell.

If Go or a C compiler is unavailable, the runner exits 2 with
`UNAVAILABLE`; compiler absence is never reported as PASS.

## Actual conformance result

The Windows PATH had no C compiler, and the first run correctly returned:

```text
UNAVAILABLE native-driver-image conformance:
C compiler unavailable (tried CC, clang, gcc, cc, cl, zig cc)
```

An existing workspace Zig compiler was then supplied explicitly only to the
runner process:

```powershell
$env:SWYPIK_ZIG='E:\nexus\.tools\zig-0.16.0\zig.exe'
python -m py_compile scripts\verify-native-driver-image.py
python scripts\verify-native-driver-image.py
```

Actual result:

```text
PASS native-driver-image differential cases=77 valid=6 reject=71 seed=0x5a17
go=go-probe.exe c=c-probe.exe
compiler=E:\nexus\.tools\zig-0.16.0\zig.exe cc
```

Tool versions observed:

```text
go version go1.27.1 windows/amd64
Zig 0.16.0
Python 3.12.10
```

No production parser divergence was found by this corpus.

## Independent runner remediation and checks

After OC2's frozen handoff, root transferred exclusive ownership of the Python
runner and these two reports to `audit_swyp`. Review found that quoted Windows
`CC` was incorrectly rejected, output was bounded only after unbounded temp-file
capture, timeout stopped only the direct child, and divergence retained the
entire temporary Go build cache. The fixes above change only the runner/reports;
both probes and all production parser inputs remain unchanged.

Nine synthetic utility checks passed on Windows: real existing Zig with quoted
and unquoted `CC` and preserved arguments; missing configured compiler; exact
capture limits on both streams; overflow on each stream; timeout of a parent,
child and grandchild; residual descendants after normal parent exit; and a
divergence retaining only four repro files while deleting build/cache output.
Seven equivalent utility checks passed under WSL/POSIX (argument parsing used
the existing Python executable, rather than asserting a Linux compiler gate).
These are runner-behavior checks, separate from real parser conformance.

The repaired worktree runner then passed the real 77-case conformance with:

```powershell
$env:SWYPIK_ZIG=$null
$env:CC='"E:\nexus\.tools\zig-0.16.0\zig.exe" cc'
& 'C:\Python312\python.exe' scripts\verify-native-driver-image.py
```

Result: **PASS, exit 0, 77 cases (6 valid / 71 reject)**. Python AST validation
and the scoped whitespace check passed.

Before integration, all **443 public OS source/document/config files** in the
frozen baseline matched both Main and the dedicated worktree, both probes kept
their original hashes, and all five Main destinations were absent. The five
claimed files were copied with exclusive destination creation into Main on
`codex/nexus-supervisor-v3`; containment/branch checks and byte-identical hashes
were verified. Active OC3 claims are separate cleanup files.

One independent real Main run, with the existing Zig supplied via
`SWYPIK_ZIG`, passed **77 cases (6 valid / 71 reject), exit 0**. Main
`git diff --check` passed; its only messages were the pre-existing CRLF-to-LF
warnings for three unrelated documentation files. Final report content was
reconciled between the worktree and Main; no stage/commit/push was performed.

## Go product gates

Focused affected package:

```powershell
go vet ./core/devicesynth
go test -count=1 ./core/devicesynth
```

Result: PASS; test output included
`ok swypik-os/core/devicesynth 0.778s`.

The required full-product gates initially could not complete because the
public-source-only OC2 worktree omitted the repository's tracked embedded font
assets used by `ui/engine`. Root coordination later restored the real public
tracked assets bit-for-bit into the worktree; their provenance and SHA-256
values are recorded in
`E:\nexus\docs\coordination\chrome-2026-10-01\opencode-public-assets.json`.
Those inherited assets were not modified by OC2.

After that snapshot repair, only the previously blocked full-product gate was
rerun with worker-private Go cache/temp directories and process-local
environment:

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```

Final combined job `jdakad9636`: **PASS, exit 0** in 58.2 seconds.

- `go vet ./...` completed successfully with no diagnostics.
- `go test -count=1 -timeout 180s ./...` reported **52 Go packages OK,
  0 failed**.
- `swypik-os/ui/engine` passed (`0.766s`), confirming the prior embed blocker
  was resolved by the inherited assets rather than by an OC2 source change.
- No UI or production parser source was modified to obtain the green gate.

## Limits

This is parser conformance only. It proves the tested Go/C parsers agree for
the deterministic corpus and common parsed fields. It does not validate driver
loading, relocation/import behavior (v1 has none), runtime isolation, hardware
mapping, boot, or production device readiness.

The process cleanup evidence covers Windows Job Object descendants and ordinary
POSIX descendants in the owned process group. It does not claim containment of
arbitrary malicious POSIX processes that detach into another session/group.
The WSL utility checks do not constitute a full Linux Go/C conformance run.
The already-passing 52-package OS gate was not repeated for this runner-only
remediation because no production source changed.
