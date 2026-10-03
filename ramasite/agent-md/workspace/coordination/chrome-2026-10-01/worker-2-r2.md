# Worker 2 — Round 2 bounded JSONL process transport

State: COMPLETE

## Workspace / branch / ownership

- MCP access verified for `E:\nexus`.
- Branch observed throughout: `codex/nexus-supervisor-v3`.
- Existing dirty/untracked work was preserved. No branch/index/history operation, reset/clean, stage/commit, push, deploy or publication was performed.
- Read before edits: root `AGENTS.md`, `swypik-os/AGENTS.md`, coordination `README.md`, current `coordinator.md`, and the owned `planprocess` sources.
- Original `worker-2.md` remains untouched and COMPLETE. Worker 5 owns the prior v3 files.
- No CLI, supervisor, generated/protocol, monitor, group/platform containment, resource, cache, energy, Control Kernel, Swyp or Ilaria source was modified.

## Exact R2 claims / changed files

Worker 2 R2 exclusively claimed and changed only:

- `swypik-os/internal/planprocess/process.go`
- `swypik-os/internal/planprocess/process_test.go`
- `swypik-os/internal/planprocess/README.md`
- `swypik-os/internal/planprocess/frame_limit_test.go` (new)
- `docs/coordination/chrome-2026-10-01/worker-2-r2.md` (new)

The scoped Git status still reports these files as untracked in the existing dirty workspace; no staging/index operation was performed.

## Stable adapter API handed to Worker 5

```go
const (
    MaxLineBytes  = 2 << 20 // backward-compatible default payload bound
    MaxJSONLBytes = 9 << 20 // maximum explicit adapter payload bound
)

type Config struct {
    // existing fields...
    JSONLMaxBytes int
}
```

Resolution rules:

- `JSONLMaxBytes == 0` => historical `MaxLineBytes` (2 MiB).
- Explicit `1..MaxJSONLBytes` => selected per-process bound.
- Negative values or values above 9 MiB return `ErrJSONLLimit`.
- Validation occurs before executable stat/pipe creation/child launch; synthetic marker tests prove the invalid child never executes.
- Existing `MaxLineBytes` remains 2 MiB for compatibility. No existing consumer is silently widened.

Additional transport errors:

- `ErrJSONLLimit` — invalid configured per-process bound.
- `ErrJSONLFrame` — non-empty stdout EOF fragment without LF/CRLF termination.
- Existing `ErrLineLimit` remains the payload-overflow error.

Worker 5 may opt a CLI/process config into `JSONLMaxBytes` only after this report becomes COMPLETE. This worker did not edit the CLI.

## Exact frame semantics

The configured limit is **payload bytes only**, identically for stdin and stdout.

### Host -> child: `SendJSON`

- Payload = exact bytes returned by `json.Marshal(value)`.
- Payload length must be <= resolved per-process bound.
- The adapter appends exactly one LF byte after the accepted payload.
- The delimiter does not count toward the configured bound.
- The write frame allocation is exactly payload + one LF; no unbounded transport buffer is introduced.
- Existing serialized send lock, pipe backpressure, context cancellation and child-reap behavior are retained.

### Child -> host: `ReadLine`

- Accepted terminators are exactly LF (`\n`) or CRLF (`\r\n`).
- Returned bytes exclude the delimiter.
- A CR counts as delimiter only when immediately before LF; otherwise it is payload.
- A non-empty EOF fragment without LF/CRLF is rejected with `ErrJSONLFrame`.
- The old `bufio.Scanner` stdout path was replaced by a fixed 64 KiB `bufio.Reader` plus explicitly bounded accumulation.
- Accumulation can hold at most configured payload + one temporary byte. The only permitted temporary +1 state is a trailing CR while determining whether the next byte is LF.
- Buffer capacity growth is explicitly clipped to that bound.
- The stdout queue remains exactly one message, so existing backpressure is preserved; no all-output accumulation/index was added.

The synthetic CRLF boundary test places CR as the final byte of the internal 64 KiB reader buffer and LF in the next read. It is accepted at the exact payload limit without widening the payload.

## Resource / containment invariants preserved

No monitor or group/platform file was edited.

Unchanged behavior retained:

- stderr retention remains bounded at 8 KiB;
- stdout queue depth remains one;
- no idle ticker or periodic transport goroutine was added;
- process lifetime cancellation still closes owned pipes, kills only the owned process through the existing adapter path, and reaps it;
- Windows Job Object and Linux cgroup v2 group mechanisms remain the strict process-tree containment authority when callers use `Group.Start`;
- environment scrub, explicit executable/runtime limits, resource sampling and Monitor semantics are unchanged.

A synthetic overflow test also starts an unrelated process outside the adapter, forces stdout overflow on the owned child, verifies the owned child has a reaped `ProcessState`, and verifies the unrelated process remains alive until test cleanup.

Existing Windows containment tests were rerun explicitly:

- `TestWindowsJobObjectAppliesAndReportsHardGroupLimits`
- `TestWindowsJobObjectMemoryLimitAndCloseTerminateChildren`
- `TestWindowsJobObjectCloseKillsDescendantProcessTree`

All passed.

## Synthetic frame/cancellation probes implemented

`frame_limit_test.go` plus the trusted test helper cover:

- exact configured payload bound for LF;
- exact configured payload bound for CRLF;
- configured bound + 1 rejected for LF;
- configured bound + 1 rejected for CRLF;
- CRLF split across the internal 64 KiB reader boundary;
- unterminated stdout frame rejected;
- default 2 MiB rejects >2 MiB stdout;
- default 2 MiB rejects >2 MiB stdin;
- explicit 9 MiB accepts an exact 9 MiB stdout payload;
- explicit 9 MiB accepts an exact 9 MiB `SendJSON` payload and child observes exactly 9 MiB before LF;
- 9 MiB + 1 rejected on stdout;
- 9 MiB + 1 rejected on stdin;
- invalid negative and >9 MiB configuration rejected before child launch;
- cancellation during a blocked exact-9-MiB write returns the context deadline and reaps the child;
- output overflow terminates/reaps the owned child and does not terminate an unrelated process.

Existing package tests continue to cover environment scrub, stderr bound, unread-output/backpressure behavior, read/write/wait cancellation, monitoring, CPU/RSS limits and persistent-child use.

## Verification evidence

Commands were run without installing tools or changing global environment.

### Focused adapter

- `go test -count=1 ./internal/planprocess`
  - PASS, final focused run: `ok swypik-os/internal/planprocess 3.125s`.
- `go vet ./internal/planprocess`
  - PASS, exit 0.
- Bridge `check_files` over `process.go`, `process_test.go`, `frame_limit_test.go`
  - PASS, no gofmt/go-vet diagnostics.

### Windows containment regression

```powershell
go test -count=1 -run "^TestWindowsJobObject(AppliesAndReportsHardGroupLimits|MemoryLimitAndCloseTerminateChildren|CloseKillsDescendantProcessTree)$" ./internal/planprocess
```

- PASS: `ok swypik-os/internal/planprocess 0.933s`.

### Final SwypikOS gate on exact handoff state

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```

- PASS, combined final job exit 0.
- **52 Go packages OK, 0 failed**.
- `internal/planprocess` passed in the full gate (`3.299s`).
- The count includes concurrently delivered packages already present in the shared working tree; it is a workspace gate, not a claim that Worker 2 implemented those packages.

### Linux race / cgroup capability

Read-only WSL probes show:

- WSL UID 1000;
- `/sys/fs/cgroup` is `cgroup2fs`;
- `/usr/bin/systemd-run` exists;
- user systemd state is `running`.

However the current WSL environment has **no native Go toolchain in PATH**:

```text
bash: line 1: go: command not found
```

An attempted delegated-scope race invocation therefore could not start `go test -race`; its inner command reported `env: 'go': No such file or directory`. This is **not** reported as a race PASS. The older temporary Linux Go toolchain documented by prior milestones is not currently available through the environment, and this task explicitly forbids installing a toolchain. No toolchain or permission change was made.

### Whitespace

- Root `git diff --check` — PASS, exit 0.
- Git emitted only the existing CRLF->LF warnings for:
  - `swypik-os/README.md`
  - `swypik-os/docs/UNIVERSAL_NATIVE.md`
  - `swypik-os/docs/WINDOWS_DESKTOP.md`
- No whitespace error was reported.
- Because this shared workspace currently records the R2-owned files as untracked, `git diff --check` does not itself inspect their contents; gofmt plus Bridge `check_files` and the package/full test gates cover the owned Go files.

## Limits / non-claims

- This is **adapter-only 9 MiB capability**. No claim of 9 MiB end-to-end supervisor/continuation support is made.
- No CLI configuration has been widened in this task.
- Worker 5 must explicitly set `Config.JSONLMaxBytes` in its owned integration path and run real cross-product continuation probes before removing the prior 2 MiB end-to-end limitation.
- `SendJSON` retains the standard-library `json.Marshal` API contract. The transport frame and pipe buffers are bounded by this adapter; this change does not attempt to impose a memory quota on arbitrary caller-owned Go values before JSON encoding.
- No new sandbox, capability, descendant-control or filesystem/network authority is introduced.

## Handoff to Worker 5

After this report transitions to `State: COMPLETE`, Worker 5 may take over these R2 files.

Recommended integration:

1. Set `JSONLMaxBytes` explicitly to the public continuation message limit needed by the CLI; do not change the default globally.
2. Keep generated/public continuation validation as the protocol authority.
3. Exercise exact-limit and +1 black-box frames through the real CLI/service, on both request and response directions.
4. Re-run Windows Job and delegated Linux cgroup integration after the CLI opts in.
5. Only after those integrated probes pass may the milestone state that 9 MiB continuation transport is supported end-to-end.
