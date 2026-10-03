# Worker 1 — Swyp serializable continuations

State: COMPLETE

## Workspace / branch

- MCP access verified for `E:\nexus`.
- Branch observed at start: `codex/nexus-supervisor-v3`.
- Existing dirty/untracked work is preserved; no branch/index/history operation will be performed.
- Applicable `AGENTS.md`, `docs/milestones/supervisor-v2.md`, and coordination README were read before edits.
- No other worker reports existed when this claim was published.

## Exact claimed files

Worker 1 exclusively claims these files until this report becomes `State: COMPLETE`:

- `swyp/internal/coreir/continuation.go`
- `swyp/internal/coreir/continuation_test.go`
- `swyp/internal/coreir/execute.go`
- `swyp/internal/coreir/execute_effects.go`
- `swyp/cmd/swyp/core_broker.go`
- `swyp/cmd/swyp/core_broker_test.go`
- `swyp/protocol/continuation/protocol.go` (new)
- `swyp/protocol/continuation/protocol_test.go` (new)
- `swyp/specs/continuation-v1.schema.json` (new)
- `docs/coordination/chrome-2026-10-01/worker-1.md`

No generated mirror and no SwypikOS/Ilaria file is claimed.

## Stable protocol/API published for Worker 2

Protocol package: `swyp-lang/protocol/continuation`.

Wire version: `1`. The payload is authority-free; Swyp contains no key, signature verifier, lease/fence, filesystem/network authority, or OS persistence primitive.

### Core identity

Every exported checkpoint has the exact v1 fields:

`protocol_version`, `type`, `state_version`, `run_id`, `module_hash`, `entry`,
`fuel_limit`, `steps_used`, `max_effect_bytes`, `effect_bytes`,
`effect_cursor`, `effect_request_hash`, `effect_result_hash`, `state_hash`, `state`.

- `type` is exactly `"continuation"`; `protocol_version=1`, `state_version=1`.
- `module_hash` is lowercase SHA-256 of the exact verified canonical Core module used by the broker.
- `effect_cursor` is the count/sequence of already resolved effects. A checkpoint is post-effect and the next emitted effect is `effect_cursor + 1`.
- `effect_request_hash` and `effect_result_hash` bind the exact validated effect exchange that produced that cursor.
- `state_hash` is SHA-256 of bounded opaque `state`; the Core state carries exact PC/call frames, typed slot payload bits, byte arena/references, storage state and original execution budgets.

Public package functions are:

`HashState`, `ValidateCheckpoint`, `DecodeCheckpoint`, `BindingBytes`, `EnvelopeHash`,
`DecodeAck`, and `ValidateAck`.

### Host-authentication boundary

Worker 2 may persist/authenticate the exact checkpoint returned by Swyp and bind its own trusted metadata/signature to `BindingBytes(checkpoint)` / `EnvelopeHash(checkpoint)`. Authentication remains host-owned. Swyp carries no key or signature verifier.

The ACK shape is exact: `protocol_version`, `type:"continuation_ack"`, `run_id`,
`module_hash`, `entry`, `effect_cursor`, `state_hash`, `status`, `error_code`.
`status` is `accepted` or `rejected`; an accepted ACK has an empty error code.

### Broker transport

Stable CLI/wire for Worker 2:

- `swyp core-broker --continuations ...`: after each successful validated effect result is incorporated, stdout emits one checkpoint frame. The broker waits for the matching continuation ACK on stdin before any next guest instruction executes.
- `swyp core-broker --resume ...`: the first stdin JSON line is the authenticated/persisted v1 checkpoint. Swyp validates module/entry/run/original budgets/state, resumes after `effect_cursor`, and never emits the resolved effect again. `--resume` also enables subsequent continuation checkpoints.
- Effect request/result framing remains the existing effects v1 JSONL contract. Continuation frames are distinguished by the exact `type` fields above.


## Implementation delivered

- Core continuation state v1 now binds canonical verified module SHA-256, entry, run ID, exact original fuel/effect-byte limits, used fuel/bytes, resolved-effect cursor, effect arena tail, storage state, and the complete interpreter frame stack.
- Every frame serializes function, block, instruction PC, caller-awaiting-child state, and every local slot. Scalar payloads use an explicit type plus exactly 16 lowercase hex digits, preserving full i64/u64 width and raw IEEE64 bits.
- Import is strict and bounded: duplicate/unknown/trailing/null JSON, incompatible version, invalid module/entry/run, changed budgets, invalid stack/call relation, non-post-effect leaf PC, slot type mismatch, out-of-arena byte references, expanded storage limits, invalid storage state, and oversized state fail closed.
- Resume requires the same executable module hash, entry, run ID, fuel limit and effect-byte limit. It starts with the checkpoint's resolved-effect cursor and resumes after the resolved effect instruction, so the provider is not invoked again for that effect.
- Broker transport is opt-in and backward-compatible: `--continuations` emits a post-effect checkpoint and waits for a strictly correlated ACK before the next guest instruction; `--resume` consumes the checkpoint as the first stdin frame, validates duplicated wire/Core metadata, resumes it, and enables subsequent checkpoints.
- Each exported broker checkpoint binds SHA-256 hashes of the exact validated effect request and result that produced the cursor. The test suite recomputes those hashes independently.
- `swyp-lang/protocol/continuation` plus `specs/continuation-v1.schema.json` are the public, authority-free host boundary. `BindingBytes` / `EnvelopeHash` provide deterministic authenticated metadata for a host-owned cryptographic wrapper; Swyp has no keys, signature verifier, persistence authority, lease, fence, filesystem or network authority.

## Verification evidence

Commands were run from `E:\nexus\swyp` unless noted.

- `go test -count=1 ./internal/coreir ./protocol/continuation ./cmd/swyp` — PASS:
  - `swyp-lang/internal/coreir` OK
  - `swyp-lang/protocol/continuation` OK
  - `swyp-lang/cmd/swyp` OK
- `go vet ./...` — PASS, exit 0.
- `go test -count=1 ./...` — PASS, 15 Go packages OK, 0 failed. Final run included `cmd/swyp`, `internal/coreir`, `internal/storageabi`, `protocol/continuation`, and `protocol/effects`.
- Bridge `check_files` over every claimed Go/JSON implementation file — PASS, zero diagnostics.
- Bridge LSP diagnostics were unavailable because `gopls` is not installed. No connector/toolchain installation was performed.
- `go test -race -count=1 ./internal/coreir ./protocol/continuation ./cmd/swyp` could not start on this Windows environment: Go reported `-race requires cgo; enable cgo by setting CGO_ENABLED=1`. No environment/toolchain mutation was made; this is not a test failure of the implementation.
- Root `git diff --check` — PASS, exit 0. Git printed only pre-existing CRLF→LF warnings for three SwypikOS documentation files; no whitespace error was reported.

Acceptance tests specifically cover uninterrupted vs resumed exact result and step count, nested call frames, storage restoration, i64/u64 64-bit preservation, IEEE64 `-0` and NaN payload preservation, byte-reference bounds, budget non-extension, corrupt/ambiguous wire data, module/run mismatch, broker state-metadata mismatch, exact effect request/result binding hashes, and zero replay of an already resolved effect.

## Explicit v1 limits

- A durable continuation is exported only at a post-effect boundary after the effect result has been validated and incorporated. This is the safe recovery boundary that gives v1 its no-replay invariant; arbitrary asynchronous instruction preemption is not claimed.
- A host can persist/authenticate the emitted checkpoint while the broker is stopped at the ACK barrier, then terminate/crash that process and resume the same checkpoint in a new broker.
- Core state is capped at 6 MiB; the continuation wire message at 9 MiB; effect response arena growth at 1 MiB; fuel at 1,000,000 instructions. Existing Core call-depth and slot limits remain in force.
- Mutable storage uses the interpreter's fixed default storage limits and cannot widen them on import. A checkpoint whose complete serialized state exceeds the 6 MiB continuation cap fails closed.
- Confidentiality, integrity keys, durable storage, task/policy/lease/fence validation and rollback protection remain SwypikOS responsibilities.

## Coordination / handoff

Worker 2's currently documented strict `ContinuationEnvelope` still reflects an older field subset. The final v1 contract is the exact field set published above; because decoding is strict, Worker 2 must mirror all of `type`, `state_version`, fuel/step/effect-byte accounting, and both effect hashes before integration. No Worker 2 file was modified here.

Changed files handed to the integrator:

- `swyp/internal/coreir/continuation.go`
- `swyp/internal/coreir/continuation_test.go`
- `swyp/internal/coreir/execute.go`
- `swyp/internal/coreir/execute_effects.go`
- `swyp/cmd/swyp/core_broker.go`
- `swyp/cmd/swyp/core_broker_test.go`
- `swyp/protocol/continuation/protocol.go`
- `swyp/protocol/continuation/protocol_test.go`
- `swyp/specs/continuation-v1.schema.json`
- `docs/coordination/chrome-2026-10-01/worker-1.md`

No generated cross-product mirror was edited. Worker 5/integrator may take over these files after this report is marked `State: COMPLETE`.
