# Effects, capabilities, and the SwypikOS broker boundary

This document defines **Effect ABI v1** for Swyp Core IR and the v1 wire
boundary that SwypikOS must implement around it. The authority invariant is:

> An effect declaration is not authority. Authority is an opaque SwypikOS
> capability that guest Swyp code cannot fabricate.

Pure Core execution remains deterministic and has no filesystem, process,
network, clock, RNG, model, tool, or device syscall/FFI path. The explicit safe
`RunWithEffects` API can suspend at `clock.read` and `fs.read` by calling an
injected handler. The handler owns transport; Swyp supplies no ambient provider.

The source frontend and standalone native backends now also support explicit
effectful builtins. Pure Core profiles reject their effectful entries;
standalone native images use their own limited process runtime. Sensitive
filesystem/network/process code generation requires the corresponding explicit
CLI grant. These broad build-time grants are not scoped SwypikOS broker
capabilities and must not be treated as a guest sandbox or production broker.

## 1. Core IR Effect ABI v1

Core IR keeps module `version: 1`. Effectful functions opt into a separately
versioned metadata surface:

```json
{
  "name": "inspect",
  "params": [{"name":"x","type":"i64"}],
  "result": "i64",
  "effect_version": 1,
  "effects": ["fs.read"],
  "required_capabilities": [
    {"name":"workspace_read","effect":"fs.read"}
  ],
  "slots": ["i64"],
  "blocks": [
    {"terminator":{"op":"return","value":0,"location":{}}}
  ]
}
```

`required_capabilities[].name` is a **logical requirement name**. It is not a
capability token, handle, bearer credential, resource locator, or secret. The
Core IR schema contains no field in which guest code can place such authority.
Unknown JSON fields are rejected by the strict decoder, so attempts to add
`capability_refs`, `token`, `handle`, or similar fields fail closed.

Pure functions are canonical when all three effect fields are omitted. Existing
pure Core IR remains accepted, including old JSON that explicitly encoded an
empty `effects` array. The source frontend infers effects and logical
requirements from supported builtins and propagates them through calls.

### 1.1 Effect registry

Effect ABI v1 accepts only these effect identifiers:

```text
clock.read
fs.read
fs.write
io.stderr
io.stdout
model.infer
net.connect
net.fetch
process.exec
rng.sample
tool.call
```

The registry is closed. Unknown effect names are invalid IR. Device operations
remain reserved until a concrete device effect vocabulary is specified instead
of guessing a generic authority class.

### 1.2 Canonical form and validation

For an effectful function:

- `effect_version` is exactly `1`;
- `effects` contains 1..16 known identifiers in strictly increasing lexical
  order, with no duplicates;
- `required_capabilities` contains 1..32 entries, ordered by `(effect, name)`;
- capability requirement names match `[a-z][a-z0-9_]{0,63}` and are unique;
- every capability requirement references a declared effect;
- every declared effect has at least one capability requirement;
- every caller propagates all effects and all capability requirements of every
  directly called function.

Because propagation is checked on every call edge, the declared profile of an
entry function is a transitive upper bound for its selected call graph. Missing
propagation is invalid IR, not an implicit ambient grant.

## 2. Prepare, execute, and verify semantics

`coreir.Prepare` validates the module and snapshots it. The prepared executable
exposes `Semantics(entry)`, which returns `purity`, `effect_version`, `effects`,
and `required_capabilities` from the owned snapshot.

Pure execution is unchanged. `Executable.Run` rejects an effectful entry with
diagnostic code `effectful_program` **before guest execution begins**. It does
not resolve a capability and does not execute a host effect.

`Executable.RunWithEffects` reuses the safe interpreter's instruction loop and
call stack. It accepts host fuel and byte budgets plus an explicit synchronous
handler. Only `clock.read` and `fs.read` are supported. Unsupported entry effects
fail before guest execution; each reachable effect instruction must have one
unambiguous logical capability requirement in its function. Host responses are
correlated and checked before resuming. Bytes are copied into a bounded per-run
arena, and `EffectRunResult.ResolveBytes` returns owned data. A cancelled context
cannot resume execution after a handler returns. The handler must respect the
context while waiting for the host. Fast/turbo execution and verification retain
their pure-only boundaries.

Contracts may now describe effects with:

```json
{
  "effect_version": 1,
  "effects": ["fs.read"]
}
```

The contract effect set must exactly match the executable entry's effect set.
For effectful programs, `Verify` validates the contract/profile and returns:

```json
{
  "status": "unknown",
  "method": "effect-contract-validation",
  "purity": "effectful",
  "reason": "effectful_execution_not_supported"
}
```

No test case is executed and no host effect occurs. This prevents bounded pure
execution from being misreported as evidence about an effect that was never
brokered.

## 3. EffectRequest / EffectResult v1 boundary

The schema in `specs/effects.swyp` generates `protocol/effects/types_gen.go`.
`protocol/effects/protocol.go` defines strict decoding, validation and canonical
hashing. `swyp core-broker --run-id RUN --entry ENTRY file.swyp` emits requests
over stdout JSONL and accepts one correlated result over stdin for each request.
See [BROKER_EXECUTION](BROKER_EXECUTION.md) for budgets and terminal frames.

### 3.1 EffectRequest

```json
{
  "protocol_version": 1,
  "request_id": "run_1:1",
  "module_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "function": "inspect",
  "effect": "fs.read",
  "capability": "workspace_read",
  "path": "input.txt"
}
```

The request carries the logical requirement name only. It never carries an
opaque capability token. SwypikOS resolves `capability` against the
current task/lease/approval context, applies scope attenuation and policy, and
either denies the request or invokes the corresponding broker implementation.

### 3.2 EffectResult

```json
{
  "protocol_version": 1,
  "request_id": "run_1:1",
  "status": "succeeded",
  "value_type": "bytes",
  "value": "aGVsbG8=",
  "error_code": ""
}
```

`status` is one of `succeeded`, `denied`, `failed`, `uncertain`, or `blocked`.
`value` is base64 JSON bytes: file content for `fs.read`, or canonical
nonnegative decimal Unix milliseconds for `clock.read` with `value_type: i64`.
Core retains its `u64` clock type after checked conversion. Unsuccessful results
contain no value and require a bounded error code. All fields are mandatory;
unknown, aliased, duplicate and trailing fields fail closed. Request IDs bind
responses to the outstanding invocation. The maximum line is 2 MiB and the
maximum decoded value is 1 MiB, further limited by the run's byte budget.

SwypikOS separately records signed `EffectReceipt` evidence containing canonical
request/result hashes, grant and task/lease/fence correlation, and status. Receipt
signing grants no authority. Receipt verification and host authorization belong
to SwypikOS; guest execution consumes only the typed result. Blind retry of an
uncertain external effect belongs to SwypikOS recovery policy, not to the Swyp VM.

## 4. Tool ABI v1 relationship

Tools use the same authority split. A descriptor declares effects and logical
requirements:

```json
{
  "version": 1,
  "tool_id": "swyp.verify",
  "input_schema_sha256": "...",
  "output_schema_sha256": "...",
  "effects": [],
  "required_capabilities": [],
  "determinism": "deterministic",
  "timeout_ms": 10000,
  "max_input_bytes": 32768,
  "max_output_bytes": 65536
}
```

Only the **SwypikOS host side** may bind opaque capability references to a
ToolCall after authorization:

```json
{
  "version": 1,
  "episode_id": "ep_...",
  "call_id": "call_...",
  "tool_id": "swyp.verify",
  "arguments": {},
  "capability_refs": [],
  "budget": {"wall_ms": 10000}
}
```

That host ToolCall is not Core IR and is never guest-authoritative. A ToolResult
must bind to `call_id` and carry result/build evidence hashes. The SwypikOS
capability broker remains the single owner of host/device effects.

## 5. Current execution boundaries

- pure Core execution rejects effectful entry functions before execution; native
  standalone process runtimes can lower supported console, clock, RNG,
  filesystem and IPv4 network operations;
- no capability minting, parsing, attenuation, storage, or validation in Swyp;
- no scheduler, lease, retry, or crash-recovery state machine in Swyp;
- explicit safe handler execution supports `clock.read` and `fs.read` only;
- source builtins carry inferred effects; general user-defined effect syntax
  remains future work.

Standalone `core-{x64,arm64}-exe` and `hir-{x64,arm64}-exe` commands require
`-allow-fs-read`, `-allow-fs-write`, `-allow-net-connect`, `-allow-net-fetch`, or
`-allow-process-exec` whenever the selected module requires that sensitive
effect. Packed modules remain pure-only. A process execution grant does not
configure executable policy; the native runtime remains fail closed until that
policy exists. Compiler output and grant checks are deterministic, while actual
native host effects are not part of pure contract verification.

The SwypikOS integration must resolve logical requirements to opaque grants and
execute or deny `EffectRequest` with scope, lease/fence, idempotency, evidence and
recovery semantics. The Swyp handler API and transport do not implement those
host authority checks.
